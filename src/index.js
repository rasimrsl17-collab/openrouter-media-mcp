// OpenRouter Media MCP server for LibreChat.
//
// Gives LibreChat Agents image, video and speech generation through OpenRouter,
// without changing LibreChat's code. How results reach the user (verified in
// LibreChat v0.8.9 source, packages/api/src/mcp/parsers.ts):
//   - images: MCP `image` content (base64) -> shown in chat like built-in image tools
//             (URL-only images are NOT shown, so we always send base64; limit 10 MB)
//   - video/audio: LibreChat has no audio/video content type. Raw `audio` content
//             would be dumped into the model context as text. So we save the file,
//             serve it from /media over HTTPS, and return a `ui://` text/html resource
//             with a <video>/<audio> player, which LibreChat renders in a sandboxed
//             iframe where the model places the UI marker.

import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import sharp from 'sharp';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, validateConfig } from './config.js';
import { reserve } from './budget.js';
import * as or from './openrouter.js';
import {
  initStorage,
  saveMedia,
  cleanupOldMedia,
  checkQuota,
  consumeQuota,
  rememberJob,
  getJob,
  updateJob,
  logUsage,
  addMediaSpend,
  localMediaPath,
} from './storage.js';
import { renderShort, renderClip, kindOf, listMusic, pickMusic, StudioError } from './studio.js';
import * as clips from './clips.js';
import { transcribeVoice } from './clips.js';
import * as social from './social.js';

const PCM_ONLY_PREFIXES = ['google/gemini', 'heygen/']; // per OpenRouter TTS docs: these return only pcm
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers -----------------------------------------------------------

const text = (t) => ({ type: 'text', text: t });
const fail = (t) => ({ isError: true, content: [text(t)] });

function quotaError(kind, q) {
  if (q.limit <= 0) return fail(`The ${kind} tool is disabled on this server.`);
  return fail(
    `Daily ${kind} limit reached for this user (${q.used}/${q.limit}). Tell the user the limit resets at 00:00 UTC.`,
  );
}

function pickModel(requested, allowed, kind) {
  if (!allowed.length) return { error: `No ${kind} models are enabled on this server.` };
  if (!requested) return { model: allowed[0] };
  if (!allowed.includes(requested)) {
    return { error: `Model "${requested}" is not allowed. Allowed ${kind} models: ${allowed.join(', ')}` };
  }
  return { model: requested };
}

function orError(err) {
  if (err instanceof or.OpenRouterError) {
    return fail(`OpenRouter error (HTTP ${err.status}): ${err.message}`);
  }
  if (err?.name === 'TimeoutError') return fail('OpenRouter did not answer in time. Try again.');
  console.error('[unexpected]', err);
  return fail(`Unexpected error: ${err?.message || err}`);
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function playerHtml(tag, url, mimeType) {
  const media =
    tag === 'video'
      ? `<video controls playsinline preload="metadata" style="display:block;width:100%;max-height:480px;border-radius:12px;background:#000"><source src="${escAttr(url)}" type="${escAttr(mimeType)}"></video>`
      : `<audio controls preload="metadata" style="display:block;width:100%"><source src="${escAttr(url)}" type="${escAttr(mimeType)}"></audio>`;
  // ui-size-change lets LibreChat (@mcp-ui/client autoResizeIframe) fit the iframe height.
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${media}<script>(function(){function s(){parent.postMessage({type:'ui-size-change',payload:{height:document.documentElement.scrollHeight}},'*')}window.addEventListener('load',s);var m=document.querySelector('${tag}');if(m)m.addEventListener('loadedmetadata',s);if(window.ResizeObserver)new ResizeObserver(s).observe(document.body);s()})();</script></body></html>`;
}

function playerResource(kind, id, url, mimeType) {
  return {
    type: 'resource',
    resource: {
      uri: `ui://openrouter-media/${kind}/${id}`,
      mimeType: 'text/html',
      text: playerHtml(kind, url, mimeType),
    },
  };
}

/** Builds a chat-displayable image (<= previewMaxBytes, png/jpeg/webp) from any image bytes. */
async function toPreview(bytes, mediaType) {
  const okType = ['image/png', 'image/jpeg', 'image/webp'].includes(mediaType);
  if (okType && bytes.length <= config.previewMaxBytes) return { bytes, mimeType: mediaType };
  let quality = 88;
  let out;
  do {
    out = await sharp(bytes, { animated: false })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    quality -= 12;
  } while (out.length > config.previewMaxBytes && quality > 30);
  return { bytes: out, mimeType: 'image/jpeg' };
}

// ---------- video model capabilities (GET /videos/models, cached 1h) -------------

let videoCapsCache = { at: 0, byId: new Map() };
async function videoCaps(modelId) {
  if (Date.now() - videoCapsCache.at > 3600_000) {
    const all = await or.listVideoModels();
    videoCapsCache = { at: Date.now(), byId: new Map(all.map((x) => [x.id, x])) };
  }
  return videoCapsCache.byId.get(modelId); // undefined -> no local validation, OpenRouter validates
}

// ---------- video finishing ---------------------------------------------------

async function finishVideo(jobId, job) {
  const info = getJob(jobId);
  if (info?.url) return info;
  const { bytes, contentType } = await or.downloadVideo(jobId, 0);
  const saved = saveMedia(bytes, contentType);
  const patch = { fileName: saved.fileName, url: saved.url, mimeType: contentType.split(';')[0] };
  // replace the provisional charge by the real one (OpenRouter reports usage.cost on completion)
  const actual = typeof job?.usage?.cost === 'number' ? job.usage.cost * config.costMarkup : info?.charged ?? 0;
  if (info?.userId && typeof info.charged === 'number') {
    addMediaSpend(info.userId, actual - info.charged);
    patch.charged = actual;
  }
  updateJob(jobId, patch);
  logUsage({ kind: 'video', userId: info?.userId, model: info?.model, jobId, cost: job?.usage?.cost ?? null, charged: actual });
  return { ...info, ...patch };
}

function videoReadyResult(jobId, info) {
  if (!info.url) {
    return fail('Video is ready but PUBLIC_BASE_URL is not configured on the MCP server, so it cannot be shown.');
  }
  return {
    content: [
      text(
        `Video is ready (job ${jobId}). Show it to the user by placing the UI Resource Marker given below in your reply, ` +
          `and also give the direct download link: ${info.url}`,
      ),
      playerResource('video', jobId.replace(/[^a-zA-Z0-9_-]/g, ''), info.url, info.mimeType || 'video/mp4'),
    ],
  };
}

async function pollVideo(jobId, maxSeconds, signal) {
  const deadline = Date.now() + maxSeconds * 1000;
  let job = await or.getVideoJob(jobId);
  while (!TERMINAL.has(job.status) && Date.now() < deadline && !signal?.aborted) {
    await sleep(config.videoPollSeconds * 1000);
    job = await or.getVideoJob(jobId);
  }
  return job;
}

async function videoOutcome(jobId, job) {
  if (job.status === 'completed') return videoReadyResult(jobId, await finishVideo(jobId, job));
  if (TERMINAL.has(job.status)) {
    const info = getJob(jobId);
    if (info?.userId && info.charged > 0) {
      addMediaSpend(info.userId, -info.charged);
      logUsage({ kind: 'video-refund', userId: info.userId, jobId, status: job.status, refunded: info.charged });
      updateJob(jobId, { charged: 0 });
    }
    const reason = job.error?.message || job.error || job.status;
    return fail(`Video generation ${job.status}: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  }
  return {
    content: [
      text(
        `Video is still generating (status: ${job.status}). Job ID: ${jobId}. ` +
          `Tell the user it is in progress, then call check_video_status with this job_id to get the result.`,
      ),
    ],
  };
}

// ---------- MCP server ----------------------------------------------------------

function buildServer(userId) {
  const server = new McpServer({ name: 'openrouter-media', version: '1.0.0' });

  // ----- image -----
  if (config.imageModels.length && config.limitImagesPerDay > 0) {
    server.registerTool(
      'generate_image',
      {
        title: 'Generate image',
        description:
          'Generate images from a text prompt via OpenRouter. The image is shown to the user automatically. ' +
          `Allowed models: ${config.imageModels.join(', ')} (default ${config.imageModels[0]}). ` +
          'Write the prompt in English for best results, describing subject, style, lighting and composition.',
        inputSchema: {
          prompt: z.string().min(1).describe('Detailed description of the image'),
          model: z.string().optional().describe('One of the allowed image models; omit for default'),
          aspect_ratio: z.string().optional().describe('e.g. 1:1, 16:9, 9:16, 4:5'),
          resolution: z.string().optional().describe('e.g. 1K or 2K, only for models that support it'),
          n: z.number().int().min(1).max(10).optional().describe('Number of images (default 1)'),
          reference_image_urls: z
            .array(z.string().url())
            .max(8)
            .optional()
            .describe('Public https image URLs to use as references / for editing (model must support it)'),
        },
      },
      async (args) => {
        const m = pickModel(args.model, config.imageModels, 'image');
        if (m.error) return fail(m.error);
        const n = Math.min(args.n ?? 1, config.maxImagesPerCall);
        const q = checkQuota(userId, 'image', n);
        if (!q.ok) return quotaError('image', q);
        const hold = await reserve(userId, config.estimateImageUsd * n);
        if (!hold.ok) return fail(hold.message);
        try {

        const body = { model: m.model, prompt: args.prompt, n, response_format: 'b64_json', user: userId };
        if (args.aspect_ratio) body.aspect_ratio = args.aspect_ratio;
        if (args.resolution) body.resolution = args.resolution;
        if (args.reference_image_urls?.length) {
          body.input_references = args.reference_image_urls.map((url) => ({ type: 'image_url', image_url: { url } }));
        }

        let json;
        try {
          json = await or.generateImages(body);
        } catch (err) {
          return orError(err);
        }

        const items = Array.isArray(json?.data) ? json.data : [];
        const content = [];
        const links = [];
        for (const item of items) {
          let bytes;
          if (item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
          else if (item.url) bytes = await or.fetchBytes(item.url);
          else continue;
          const mediaType = item.media_type || 'image/png';
          const saved = saveMedia(bytes, mediaType);
          if (saved.url) links.push(saved.url);
          const preview = await toPreview(bytes, mediaType);
          content.push({ type: 'image', data: preview.bytes.toString('base64'), mimeType: preview.mimeType });
        }
        if (!content.length) {
          console.error('[generate_image] no image in response:', JSON.stringify(json).slice(0, 1500));
          return fail('OpenRouter returned no image for this request. Try a different prompt or model.');
        }

        consumeQuota(userId, 'image', content.length);
        const imgCost = typeof json?.usage?.cost === 'number' ? json.usage.cost : config.estimateImageUsd * content.length;
        const imgCharged = imgCost * config.costMarkup;
        addMediaSpend(userId, imgCharged);
        logUsage({ kind: 'image', userId, model: m.model, count: content.length, cost: json?.usage?.cost ?? null, charged: imgCharged });
        content.unshift(
          text(
            `Generated ${content.length} image(s) with ${m.model}. They are already displayed to the user; do not repeat them as markdown.` +
              (links.length ? ` Full-resolution download link(s): ${links.join(' , ')}` : ''),
          ),
        );
        return { content };
        } finally {
          hold.release();
        }
      },
    );
  }

  // ----- video -----
  if (config.videoModels.length && config.limitVideosPerDay > 0) {
    server.registerTool(
      'generate_video',
      {
        title: 'Generate video',
        description:
          'Generate a short video from a text prompt via OpenRouter. Takes about 1-4 minutes. ' +
          `Allowed models: ${config.videoModels.join(', ')} (default ${config.videoModels[0]}). ` +
          `Max duration ${config.maxVideoSeconds}s, resolutions: ${config.allowedVideoResolutions.join(', ')}. ` +
          'If it is not finished within the wait time you get a job_id: then call check_video_status.',
        inputSchema: {
          prompt: z.string().min(1).describe('Scene description: subject, action, camera, style'),
          model: z.string().optional(),
          duration: z.number().int().min(1).optional().describe('Seconds; must be supported by the model'),
          resolution: z.string().optional().describe('e.g. 480p or 720p'),
          aspect_ratio: z.string().optional().describe('e.g. 16:9 or 9:16'),
          generate_audio: z.boolean().optional().describe('Generate sound, only for models that support it'),
          first_frame_image_url: z.string().url().optional().describe('Public https image to use as the first frame'),
        },
      },
      async (args, extra) => {
        const m = pickModel(args.model, config.videoModels, 'video');
        if (m.error) return fail(m.error);
        if (args.duration && args.duration > config.maxVideoSeconds) {
          return fail(`Duration ${args.duration}s is above this server's limit of ${config.maxVideoSeconds}s.`);
        }
        if (args.resolution && !config.allowedVideoResolutions.includes(args.resolution)) {
          return fail(`Resolution ${args.resolution} is not allowed. Allowed: ${config.allowedVideoResolutions.join(', ')}`);
        }
        const q = checkQuota(userId, 'video', 1);
        if (!q.ok) return quotaError('video', q);

        let caps;
        try {
          caps = await videoCaps(m.model);
        } catch (err) {
          return orError(err);
        }
        const body = { model: m.model, prompt: args.prompt, user: userId };

        // resolution: requested one, or the first allowed resolution this model supports
        const modelRes = caps?.supported_resolutions;
        if (args.resolution) {
          if (modelRes && !modelRes.includes(args.resolution)) {
            return fail(`${m.model} does not support ${args.resolution}. Supported: ${modelRes.join(', ')}`);
          }
          body.resolution = args.resolution;
        } else if (modelRes) {
          const pick = config.allowedVideoResolutions.find((r) => modelRes.includes(r));
          if (!pick) {
            return fail(
              `${m.model} supports only ${modelRes.join(', ')}, none of which is allowed on this server (${config.allowedVideoResolutions.join(', ')}).`,
            );
          }
          body.resolution = pick;
        }

        // duration: requested one, or the longest supported duration within the server cap
        const modelDur = (caps?.supported_durations || []).filter((d) => d > 0);
        if (args.duration) {
          if (modelDur.length && !modelDur.includes(args.duration)) {
            return fail(`${m.model} supports durations ${modelDur.join(', ')}s, not ${args.duration}s.`);
          }
          body.duration = args.duration;
        } else if (modelDur.length) {
          const within = modelDur.filter((d) => d <= config.maxVideoSeconds);
          if (!within.length) {
            return fail(`${m.model}'s shortest video (${Math.min(...modelDur)}s) is above this server's ${config.maxVideoSeconds}s cap.`);
          }
          body.duration = Math.max(...within);
        }

        if (args.aspect_ratio) {
          const ar = caps?.supported_aspect_ratios;
          if (ar && !ar.includes(args.aspect_ratio)) {
            return fail(`${m.model} supports aspect ratios ${ar.join(', ')}, not ${args.aspect_ratio}.`);
          }
          body.aspect_ratio = args.aspect_ratio;
        }
        if (args.generate_audio !== undefined) {
          if (args.generate_audio && caps && caps.generate_audio === false) {
            return fail(`${m.model} cannot generate audio.`);
          }
          body.generate_audio = args.generate_audio;
        }
        if (args.first_frame_image_url) {
          const fi = caps?.supported_frame_images;
          if (fi && !fi.includes('first_frame')) return fail(`${m.model} does not accept a first-frame image.`);
          body.frame_images = [
            { type: 'image_url', image_url: { url: args.first_frame_image_url }, frame_type: 'first_frame' },
          ];
        }

        // Hold the estimated cost; once the job exists it becomes a provisional charge that is
        // corrected to the real cost on completion (or refunded if the job fails).
        const estSeconds = body.duration ?? config.maxVideoSeconds;
        const hold = await reserve(userId, config.estimateVideoUsdPerSecond * estSeconds);
        if (!hold.ok) return fail(hold.message);

        let submitted;
        try {
          submitted = await or.submitVideo(body);
        } catch (err) {
          hold.release();
          return orError(err);
        }
        const jobId = submitted?.id;
        if (!jobId) {
          hold.release();
          return fail('OpenRouter did not return a job id.');
        }
        consumeQuota(userId, 'video', 1);
        const provisional = config.estimateVideoUsdPerSecond * estSeconds * config.costMarkup;
        addMediaSpend(userId, provisional);
        hold.release();
        rememberJob(jobId, { userId, model: m.model, charged: provisional });

        try {
          const job = await pollVideo(jobId, config.videoMaxWaitSeconds, extra?.signal);
          return await videoOutcome(jobId, job);
        } catch (err) {
          return orError(err);
        }
      },
    );

    server.registerTool(
      'check_video_status',
      {
        title: 'Check video status',
        description: 'Check a video started by generate_video. Returns the video when ready.',
        inputSchema: { job_id: z.string().min(1) },
      },
      async ({ job_id }, extra) => {
        const info = getJob(job_id);
        if (!info || info.userId !== userId) return fail('Unknown job_id for this user.');
        if (info.url) return videoReadyResult(job_id, info);
        try {
          const job = await pollVideo(job_id, 45, extra?.signal);
          return await videoOutcome(job_id, job);
        } catch (err) {
          return orError(err);
        }
      },
    );
  }

  // ----- speech -----
  if (config.ttsModels.length && config.limitTtsPerDay > 0) {
    server.registerTool(
      'generate_speech',
      {
        title: 'Text to speech',
        description:
          'Turn text into spoken audio (MP3) via OpenRouter and show an audio player. ' +
          `Allowed models: ${config.ttsModels.join(', ')} (default ${config.ttsModels[0]}, default voice ${config.defaultTtsVoice}). ` +
          'Voice IDs are model-specific; use list_media_models with kind=speech to see them.',
        inputSchema: {
          text: z.string().min(1).describe('Text to speak'),
          model: z.string().optional(),
          voice: z.string().optional(),
          instructions: z.string().optional().describe('Tone/pacing guidance, only some models use it'),
          speed: z.number().min(0.25).max(4).optional(),
        },
      },
      async (args) => {
        const m = pickModel(args.model, config.ttsModels, 'speech');
        if (m.error) return fail(m.error);
        if (PCM_ONLY_PREFIXES.some((p) => m.model.startsWith(p))) {
          return fail(`${m.model} only returns raw PCM audio, which this server does not support. Use another model.`);
        }
        if (args.text.length > config.maxTtsChars) {
          return fail(`Text is ${args.text.length} characters; the limit is ${config.maxTtsChars}.`);
        }
        const q = checkQuota(userId, 'tts', 1);
        if (!q.ok) return quotaError('speech', q);
        // OpenRouter returns no cost for speech, so the estimate is also what gets charged.
        const ttsCost = (args.text.length / 1000) * config.estimateTtsUsdPer1kChars;
        const hold = await reserve(userId, ttsCost);
        if (!hold.ok) return fail(hold.message);
        try {

        const voice = args.voice || (m.model === config.ttsModels[0] ? config.defaultTtsVoice : undefined);
        const body = { model: m.model, input: args.text, response_format: 'mp3' };
        if (voice) body.voice = voice;
        if (args.instructions) body.instructions = args.instructions;
        if (args.speed) body.speed = args.speed;

        let audio;
        try {
          audio = await or.synthesizeSpeech(body);
        } catch (err) {
          return orError(err);
        }
        const mimeType = audio.contentType.split(';')[0];
        const saved = saveMedia(audio.bytes, mimeType);
        if (!saved.url) return fail('PUBLIC_BASE_URL is not configured, so the audio cannot be shown.');
        consumeQuota(userId, 'tts', 1);
        const ttsCharged = ttsCost * config.costMarkup;
        addMediaSpend(userId, ttsCharged);
        logUsage({ kind: 'tts', userId, model: m.model, chars: args.text.length, generationId: audio.generationId, charged: ttsCharged });

        return {
          content: [
            text(
              `Audio is ready. Show the player by placing the UI Resource Marker given below in your reply, ` +
                `and give the direct download link: ${saved.url}`,
            ),
            playerResource('audio', saved.fileName.split('.')[0], saved.url, mimeType),
          ],
        };
        } finally {
          hold.release();
        }
      },
    );
  }

  // ----- Creator Studio: assemble a vertical short -----
  if (config.limitShortsPerDay > 0) {
    server.registerTool(
      'assemble_short',
      {
        title: 'Assemble short video',
        description:
          'Combine scenes (images and/or video clips made earlier with generate_image / generate_video) plus an optional ' +
          'voiceover (from generate_speech) into ONE vertical 1080x1920 MP4 for YouTube Shorts, TikTok and Reels. ' +
          'Still images get a slow zoom/pan (motion). With a voiceover, captions are word-by-word in sync with the speech ' +
          '(active word highlighted); without one, each scene shows its caption. Optional background music ducks under the voice. ' +
          'Use the full-size /media/ links those tools returned. If the voiceover is longer than the scenes, the last scene is ' +
          `held until the speech ends. Max ${config.maxShortSeconds}s. Cost: free, plus a tiny speech-recognition fee for word captions.` +
          (listMusic().length ? ` Music tracks: ${listMusic().map((t) => t.name).join(', ')} (or a mood prefix, e.g. "calm").` : ''),
        inputSchema: {
          scenes: z
            .array(
              z.object({
                media_url: z.string().url().describe('A /media/ link returned by generate_image or generate_video'),
                seconds: z.number().min(1).max(20).describe('How long this scene is shown'),
                caption: z.string().max(160).optional().describe('On-screen text for this scene (short, punchy)'),
              }),
            )
            .min(1)
            .max(15),
          voiceover_url: z.string().url().optional().describe('The /media/ mp3 link returned by generate_speech'),
          caption_style: z
            .enum(['words', 'scene', 'none'])
            .optional()
            .describe('words = synced word-by-word from the voiceover (default when there is a voiceover); scene = each scene caption; none'),
          title: z.string().max(60).optional().describe('Optional hook text pinned at the top, e.g. "3 facts nobody tells you"'),
          motion: z.boolean().optional().describe('Animate still images with zoom/pan (default true)'),
          music: z.string().max(60).optional().describe('Background music track name or mood prefix (see description); omit for none'),
          language: z.string().max(5).optional().describe('ISO code of the voiceover language (e.g. en, tr, es) for better word captions'),
        },
      },
      async (args) => {
        const q = checkQuota(userId, 'short', 1);
        if (!q.ok) return quotaError('short video', q);
        const scenes = [];
        for (const [i, s] of args.scenes.entries()) {
          const file = localMediaPath(s.media_url);
          const kind = file && kindOf(file);
          if (!file || (kind !== 'image' && kind !== 'video')) {
            return fail(`Scene ${i + 1}: use an image or video link created by this server's tools (…/media/…); got ${s.media_url}`);
          }
          scenes.push({ file, kind, seconds: s.seconds, caption: s.caption });
        }
        let voiceFile;
        if (args.voiceover_url) {
          voiceFile = localMediaPath(args.voiceover_url);
          if (!voiceFile || kindOf(voiceFile) !== 'audio') {
            return fail('voiceover_url must be an audio link created by generate_speech (…/media/….mp3).');
          }
        }
        let musicFile;
        if (args.music) {
          const t = pickMusic(args.music);
          if (!t) {
            const names = listMusic().map((x) => x.name);
            return fail(names.length ? `No music track matches "${args.music}". Available: ${names.join(', ')}.` : 'No background music is installed on this server; leave music empty.');
          }
          musicFile = t.file;
        }
        const style = args.caption_style ?? (voiceFile ? 'words' : 'scene');
        if (style === 'none') scenes.forEach((s) => delete s.caption);
        let words;
        let sttNote = '';
        if (style === 'words' && voiceFile) {
          try {
            const r = await transcribeVoice(voiceFile, args.language);
            words = r.words;
            const charged = r.cost * config.costMarkup;
            if (charged > 0) addMediaSpend(userId, charged);
            logUsage({ kind: 'stt', userId, model: config.sttModel, cost: r.cost, charged });
            if (!words.length) sttNote = ' (No words were recognised in the voiceover, so scene captions were used instead.)';
          } catch (err) {
            console.error('[assemble_short stt]', err?.message || err);
            sttNote = ' (Word captions were unavailable, so scene captions were used instead.)';
          }
        }
        let out;
        try {
          out = await renderShort({ scenes, voiceFile, words, musicFile, motion: args.motion ?? true, title: args.title });
        } catch (err) {
          if (err instanceof StudioError) return fail(err.message);
          console.error('[assemble_short]', err);
          return fail(`Could not build the video: ${err?.message || err}`);
        }
        const saved = saveMedia(out.bytes, 'video/mp4');
        if (!saved.url) return fail('PUBLIC_BASE_URL is not configured, so the video cannot be shown.');
        consumeQuota(userId, 'short', 1);
        logUsage({ kind: 'short', userId, seconds: out.seconds, scenes: scenes.length });
        return {
          content: [
            text(
              `Short video ready (${out.seconds.toFixed(1)}s, 1080x1920)${sttNote}. Show it by placing the UI Resource Marker given below ` +
                `in your reply, and give the download link. Use this exact link as video_url when publishing: ${saved.url}`,
            ),
            playerResource('video', saved.fileName.split('.')[0], saved.url, 'video/mp4'),
          ],
        };
      },
    );
  }

  // ----- Creator Studio: long video -> clips -----
  if (config.limitSourceMinutesPerDay > 0 && config.limitClipsPerDay > 0) {
    const sourceReply = (meta) => {
      if (!meta) return fail('Unknown source_id. Start again with transcribe_video.');
      if (meta.status === 'failed') return fail(`Processing the video failed: ${meta.error}`);
      if (meta.status !== 'ready') {
        return {
          content: [
            text(
              `Still ${meta.status} (source_id: ${meta.id}). Tell the user it is in progress, then call get_video_transcript ` +
                'with this source_id again (it waits up to a few minutes each time).',
            ),
          ],
        };
      }
      const min = Math.floor(meta.seconds / 60);
      const sec = Math.round(meta.seconds % 60);
      return {
        content: [
          text(
            `Video ready (source_id: ${meta.id}, ${min}m${String(sec).padStart(2, '0')}s, ${meta.width}x${meta.height}` +
              `${meta.language ? `, language: ${meta.language}` : ''}). Timestamped transcript below. Pick the strongest self-contained ` +
              `moments (a clear hook in the first 2 seconds, one idea, a satisfying ending), each 15-${config.maxShortSeconds}s, and ` +
              'call cut_clips with exact start/end seconds taken from these timestamps.\n\n' +
              clips.transcriptText(meta),
          ),
        ],
      };
    };

    server.registerTool(
      'transcribe_video',
      {
        title: 'Load a long video for clipping',
        description:
          "Load the user's own long video (podcast, interview, stream, lesson) from a link and transcribe it with timestamps, " +
          'so you can choose the best moments and turn them into vertical clips with cut_clips. Accepts direct https video links, ' +
          'Google Drive share links ("Anyone with the link") and Dropbox links. YouTube/TikTok/Instagram page links are NOT supported; ' +
          `ask for the file instead. Max ${config.maxSourceMinutes} min, ${config.maxSourceMb} MB. ` +
          `Cost: about $${(config.clipUsdPerMinute * config.costMarkup).toFixed(3)} per minute of video. ` +
          'The user must own the video or have the right to reuse it.',
        inputSchema: {
          url: z.string().url().describe('Link to the video file'),
          language: z.string().max(5).optional().describe('ISO code of the spoken language if known (e.g. en, tr, es)'),
        },
      },
      async ({ url, language }) => {
        if (userId === 'anonymous') return fail('Clipping needs a signed-in user. Ask the user to sign in again.');
        try {
          clips.directUrl(url);
        } catch (err) {
          return fail(err.message);
        }
        const id = clips.startSource({
          userId,
          url,
          language,
          hooks: {
            async check(minutes) {
              const q = checkQuota(userId, 'source_min', minutes);
              if (!q.ok) {
                return { ok: false, message: `Daily video-minutes limit reached (${q.used}/${q.limit} min used today; this video is ${minutes} min).` };
              }
              return reserve(userId, minutes * config.clipUsdPerMinute);
            },
            done(minutes, sttCost) {
              consumeQuota(userId, 'source_min', minutes);
              const charged = minutes * config.clipUsdPerMinute * config.costMarkup;
              addMediaSpend(userId, charged);
              logUsage({ kind: 'source', userId, minutes, cost: sttCost, charged });
            },
          },
        });
        return sourceReply(await clips.waitSource(id, config.sourceWaitSeconds));
      },
    );

    server.registerTool(
      'get_video_transcript',
      {
        title: 'Get long-video transcript',
        description: 'Check a video loaded with transcribe_video. Waits a few minutes if it is still processing, then returns the timestamped transcript.',
        inputSchema: { source_id: z.string().describe('source_id returned by transcribe_video') },
      },
      async ({ source_id }) => {
        const meta = clips.readMeta(source_id);
        if (!meta || meta.userId !== userId) return fail('Unknown source_id. Start again with transcribe_video.');
        return sourceReply(await clips.waitSource(source_id, config.sourceWaitSeconds));
      },
    );

    server.registerTool(
      'cut_clips',
      {
        title: 'Cut vertical clips from a long video',
        description:
          'Cut moments from a video loaded with transcribe_video into vertical 1080x1920 clips with word-by-word captions, ' +
          `ready for Shorts/TikTok/Reels. Up to ${config.maxClipsPerCall} clips per call, each 5-${config.maxShortSeconds}s. ` +
          'framing: "center" crops the middle of the frame (best for one person talking to camera); "fit" keeps the whole frame ' +
          'over a blurred background (best for two people, screen recordings, wide shots). No AI cost.',
        inputSchema: {
          source_id: z.string(),
          clips: z
            .array(
              z.object({
                start: z.number().min(0).describe('Start, in seconds from the beginning of the video'),
                end: z.number().describe('End, in seconds'),
                title: z.string().max(60).optional().describe('Hook text pinned at the top of the clip'),
              }),
            )
            .min(1)
            .max(Math.max(1, config.maxClipsPerCall)),
          framing: z.enum(['center', 'fit']).optional(),
          captions: z.boolean().optional().describe('Word-by-word captions (default true)'),
          music: z.string().max(60).optional().describe('Optional background music track name or mood prefix'),
        },
      },
      async (args) => {
        const meta = clips.readMeta(args.source_id);
        if (!meta || meta.userId !== userId) return fail('Unknown source_id. Load the video with transcribe_video first.');
        if (meta.status !== 'ready') return sourceReply(meta);
        const file = clips.videoPath(meta.id);
        if (!fs.existsSync(file)) return fail('This video has expired from the server. Load it again with transcribe_video.');
        for (const [i, c] of args.clips.entries()) {
          const len = c.end - c.start;
          if (!(len >= 5 && len <= config.maxShortSeconds) || c.end > meta.seconds + 0.5) {
            return fail(`Clip ${i + 1}: needs 5-${config.maxShortSeconds}s inside the video (0-${meta.seconds.toFixed(0)}s); got ${c.start}-${c.end}.`);
          }
        }
        const q = checkQuota(userId, 'clip', args.clips.length);
        if (!q.ok) return quotaError('clip', q);
        let musicFile;
        if (args.music) {
          const t = pickMusic(args.music);
          if (!t) return fail(`No music track matches "${args.music}".`);
          musicFile = t.file;
        }
        const content = [];
        const links = [];
        for (const [i, c] of args.clips.entries()) {
          try {
            const out = await renderClip({
              sourceFile: file,
              start: c.start,
              end: Math.min(c.end, meta.seconds),
              framing: args.framing ?? 'center',
              words: args.captions === false ? [] : meta.words,
              title: c.title,
              musicFile,
            });
            const saved = saveMedia(out.bytes, 'video/mp4');
            if (!saved.url) return fail('PUBLIC_BASE_URL is not configured, so the clips cannot be shown.');
            consumeQuota(userId, 'clip', 1);
            logUsage({ kind: 'clip', userId, seconds: out.seconds });
            links.push(`Clip ${i + 1} (${out.seconds.toFixed(1)}s): ${saved.url}`);
            content.push(playerResource('video', saved.fileName.split('.')[0], saved.url, 'video/mp4'));
          } catch (err) {
            if (!(err instanceof StudioError)) console.error('[cut_clips]', err);
            links.push(`Clip ${i + 1}: failed (${err?.message || err})`);
          }
        }
        content.unshift(
          text(
            'Clips are done. Show each one by placing its UI Resource Marker in your reply and list the links. ' +
              'Use these exact links as media when publishing:\n' + links.join('\n'),
          ),
        );
        return { content };
      },
    );
  }

  // ----- Creator Studio: social publishing (Zernio) -----
  if (config.zernioKey && config.limitPostsPerDay > 0) {
    const anon = () => fail('Publishing needs a signed-in user. Ask the user to sign in again.');
    const socialFail = (err) => {
      if (err instanceof social.SocialError) return fail(`Publishing service error${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`);
      console.error('[social]', err);
      return fail(`Unexpected publishing error: ${err?.message || err}`);
    };

    if (config.socialPlatforms.length) server.registerTool(
      'social_connect_account',
      {
        title: 'Connect a social account',
        description:
          "Get a secure link where the user connects their OWN social media account (they log in on the platform's site; " +
          `we never see their password). Platforms: ${config.socialPlatforms.join(', ')}. Give the link to the user and ` +
          'ask them to tell you when they are done, then call social_list_accounts.',
        inputSchema: { platform: z.enum(config.socialPlatforms) },
      },
      async ({ platform }) => {
        if (userId === 'anonymous') return anon();
        try {
          const url = await social.connectUrl(userId, platform);
          return { content: [text(`Give the user this link to connect their ${platform} account (valid for a limited time): ${url}`)] };
        } catch (err) {
          return socialFail(err);
        }
      },
    );

    server.registerTool(
      'social_list_accounts',
      {
        title: 'List connected social accounts',
        description: "List the user's own connected social accounts with the account_id needed for social_publish.",
        inputSchema: {},
      },
      async () => {
        if (userId === 'anonymous') return anon();
        try {
          const accounts = await social.listAccounts(userId);
          if (!accounts.length) {
            return { content: [text('No accounts connected yet. Offer social_connect_account for the platform the user wants.')] };
          }
          return { content: [text(JSON.stringify(accounts, null, 1))] };
        } catch (err) {
          return socialFail(err);
        }
      },
    );

    server.registerTool(
      'social_publish',
      {
        title: 'Publish or schedule a post',
        description:
          "Publish, schedule or save as draft a video/images to the user's connected accounts. ONLY call this after the user " +
          'has seen the final video and caption and explicitly said yes to posting them to the named accounts. ' +
          'Media must be links created by this server (e.g. the assemble_short result).' +
          (config.socialPostFeeUsd > 0 ? ` Costs $${config.socialPostFeeUsd} credit per published post.` : ''),
        inputSchema: {
          media_urls: z.array(z.string().url()).min(1).max(10).describe('Usually one: the assemble_short video link'),
          caption: z.string().min(1).max(2200).describe('Post text with hashtags; first line is used as the YouTube title if none given'),
          targets: z
            .array(
              z.object({
                account_id: z.string().min(1).describe('From social_list_accounts'),
                youtube_title: z.string().max(100).optional(),
              }),
            )
            .min(1)
            .max(10),
          mode: z.enum(['now', 'schedule', 'draft']).describe('now = publish immediately; schedule = at scheduled_for; draft = save only'),
          scheduled_for: z.string().optional().describe('ISO 8601 time, required for mode=schedule, e.g. 2026-12-01T18:00:00'),
          timezone: z.string().optional().describe('IANA zone for scheduled_for without offset, e.g. America/New_York'),
        },
      },
      async (args) => {
        if (userId === 'anonymous') return anon();
        if (args.mode === 'schedule' && !args.scheduled_for) return fail('scheduled_for is required when mode is schedule.');
        for (const u of args.media_urls) {
          if (!localMediaPath(u)) return fail(`Only media created by this server can be published; ${u} is not one.`);
        }
        const q = checkQuota(userId, 'post', 1);
        if (!q.ok) return quotaError('post', q);
        const fee = args.mode === 'draft' ? 0 : config.socialPostFeeUsd * args.targets.length;
        const hold = fee > 0 ? await reserve(userId, fee) : { ok: true, release() {} };
        if (!hold.ok) return fail(hold.message);
        try {
          const r = await social.publish(userId, {
            mediaUrls: args.media_urls,
            caption: args.caption,
            targets: args.targets,
            mode: args.mode,
            scheduledFor: args.scheduled_for,
            timezone: args.timezone,
          });
          const failed = r.httpStatus === 207 && r.status === 'failed';
          if (!failed) {
            consumeQuota(userId, 'post', 1);
            if (fee > 0) addMediaSpend(userId, fee * config.costMarkup);
          }
          logUsage({ kind: 'post', userId, mode: args.mode, postId: r.postId, status: r.status, targets: args.targets.length, charged: failed ? 0 : fee * config.costMarkup });
          const summary = { post_id: r.postId, status: r.status, platforms: r.platforms, error: r.error, warnings: r.warnings };
          return {
            ...(failed ? { isError: true } : {}),
            content: [
              text(
                (failed
                  ? 'Publishing FAILED on every platform. Explain the error to the user in simple words.'
                  : r.httpStatus === 207
                    ? 'Published on some platforms only. Tell the user which ones failed and why.'
                    : `Done (${args.mode}).`) +
                  '\n' +
                  JSON.stringify(summary, null, 1).slice(0, 4000),
              ),
            ],
          };
        } catch (err) {
          return socialFail(err);
        } finally {
          hold.release();
        }
      },
    );
  }

  // ----- discovery -----
  server.registerTool(
    'list_media_models',
    {
      title: 'List media models',
      description: 'List the enabled image, video or speech models with their supported options (and voices for speech).',
      inputSchema: { kind: z.enum(['image', 'video', 'speech']) },
    },
    async ({ kind }) => {
      try {
        if (kind === 'image') {
          const all = await or.listImageModels();
          const rows = all
            .filter((x) => config.imageModels.includes(x.id))
            .map((x) => ({ id: x.id, name: x.name, supported_parameters: x.supported_parameters }));
          return { content: [text(JSON.stringify(rows, null, 1))] };
        }
        if (kind === 'video') {
          const all = await or.listVideoModels();
          const rows = all.filter((x) => config.videoModels.includes(x.id));
          return {
            content: [
              text(
                JSON.stringify(rows, null, 1).slice(0, 12000) +
                  `\nServer caps: max ${config.maxVideoSeconds}s, resolutions ${config.allowedVideoResolutions.join(', ')}`,
              ),
            ],
          };
        }
        const all = await or.listSpeechModels();
        const rows = all
          .filter((x) => config.ttsModels.includes(x.id))
          .map((x) => ({ id: x.id, name: x.name, voices: (x.supported_voices ?? []).slice(0, 60) }));
        return { content: [text(JSON.stringify(rows, null, 1))] };
      } catch (err) {
        return orError(err);
      }
    },
  );

  return server;
}

// ---------- HTTP ----------------------------------------------------------------

function authorized(req) {
  if (!config.sharedSecret) return config.allowNoAuth;
  const got = Buffer.from(String(req.get('x-api-key') || ''));
  const want = Buffer.from(config.sharedSecret);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function userIdFrom(req) {
  const raw = String(req.get('x-user-id') || '').trim();
  // LibreChat leaves the placeholder untouched if it cannot resolve it.
  if (!raw || raw.includes('{{')) return 'anonymous';
  return raw.slice(0, 64);
}

const problems = validateConfig();
if (problems.length) {
  console.error('Configuration problems:\n - ' + problems.join('\n - '));
  process.exit(1);
}
initStorage();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Public media (videos, audio, full-size images). Range requests are supported for seeking.
app.use(
  '/media',
  express.static(config.mediaDir, {
    index: false,
    dotfiles: 'deny',
    maxAge: '7d',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/mcp', async (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  const server = buildServer(userIdFrom(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp]', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

// Stateless server: no SSE stream / session deletion.
const methodNotAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

const httpServer = app.listen(config.port, () => {
  console.log(`openrouter-media MCP listening on :${config.port}  (POST /mcp, GET /media/*)`);
  console.log(`image: ${config.imageModels.join(', ') || '-'} | video: ${config.videoModels.join(', ') || '-'} | tts: ${config.ttsModels.join(', ') || '-'}`);
});
// Video calls can wait several minutes.
httpServer.requestTimeout = 0;
httpServer.headersTimeout = 120_000;

setInterval(() => {
  const n = cleanupOldMedia();
  if (n) console.log(`[cleanup] removed ${n} old media files`);
}, 6 * 3600_000).unref();
