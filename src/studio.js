// Video building blocks shared by assemble_short and cut_clips. Pure ffmpeg, no paid API.
//
// assemble_short: scenes (images / video clips made by this server) + optional voiceover +
// captions (per scene, or word-by-word from a transcript) + optional background music
// -> one vertical 1080x1920 MP4 for YouTube Shorts, TikTok and Reels.
//
// Only files this server saved itself are accepted as inputs (checked by the caller).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

export const W = 1080;
export const H = 1920;
export const FPS = 30;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a']);

export class StudioError extends Error {}

// ---- tiny semaphore: a 1-2 vCPU droplet should not encode many videos at once ----
let running = 0;
const waiting = [];
export async function acquire() {
  if (running < Math.max(1, config.maxConcurrentRenders)) {
    running++;
    return;
  }
  await new Promise((r) => waiting.push(r));
  running++;
}
export function release() {
  running--;
  waiting.shift()?.();
}

export function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(new StudioError(`${cmd} could not start: ${e.message}`));
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new StudioError(`${cmd} failed (exit ${code}): ${err.split('\n').slice(-6).join(' | ')}`));
    });
  });
}

export async function probe(file) {
  const out = await run(
    config.ffprobePath,
    ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file],
    60_000,
  );
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  return {
    seconds: Number(j.format?.duration) || 0,
    hasVideo: !!v,
    hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
    width: v?.width,
    height: v?.height,
  };
}

export async function probeSeconds(file) {
  const { seconds } = await probe(file);
  if (!(seconds > 0)) throw new StudioError('Could not read the length of the audio file.');
  return seconds;
}

// ---------------- captions (ASS subtitles) ----------------
const assTime = (sec) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = (t) =>
  String(t)
    .replace(/\\/g, '')
    .replace(/[{}]/g, '')
    .replace(/\r?\n/g, '\\N')
    .trim();

const YELLOW = '&H0000E5FF&'; // ASS colours are &HBBGGRR&
const WHITE = '&H00FFFFFF&';

/** Group word timestamps into short on-screen chunks (max 3 words / 1.2 s, break on punctuation). */
export function chunkWords(words) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    const text = String(w.word ?? '').trim();
    if (!text || !(w.end > w.start - 1e-9)) continue;
    cur.push({ text, start: w.start, end: w.end });
    const span = cur[cur.length - 1].end - cur[0].start;
    if (cur.length >= 3 || span >= 1.2 || /[.!?,;:…]$/.test(text)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * cues:      [{ start, end, text }]                 plain captions (one block per cue)
 * wordCues:  [[{ text, start, end }, ...], ...]     word-by-word chunks, active word highlighted
 * title:     optional hook text shown at the top for the whole video
 */
export function buildAss({ cues = [], wordCues = [], title, duration }) {
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${config.captionFont},74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,430,1`,
    `Style: Word,${config.captionFont},92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,2,70,70,520,1`,
    `Style: Title,${config.captionFont},70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,3,14,0,8,70,70,170,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = [];
  if (title && title.trim()) lines.push(`Dialogue: 1,${assTime(0)},${assTime(duration)},Title,,0,0,0,,${assText(title)}`);
  for (const c of cues) lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${assText(c.text)}`);
  for (const chunk of wordCues) {
    const chunkEnd = chunk[chunk.length - 1].end + 0.15;
    chunk.forEach((w, i) => {
      const from = w.start;
      const to = i < chunk.length - 1 ? chunk[i + 1].start : chunkEnd;
      if (to <= from) return;
      const text = chunk
        .map((x, j) => (j === i ? `{\\c${YELLOW}}${assText(x.text)}{\\c${WHITE}}` : assText(x.text)))
        .join(' ');
      lines.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Word,,0,0,0,,${text}`);
    });
  }
  return head.concat(lines).join('\n') + '\n';
}

// ---------------- motion ("Ken Burns") for still images ----------------
const MOTIONS = ['in', 'right', 'out', 'left'];
function stillFilter(i, seconds, motionIdx) {
  const n = Math.max(1, Math.round(seconds * FPS));
  if (motionIdx < 0) {
    return (
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,` +
      `loop=loop=${n - 1}:size=1:start=0,fps=${FPS},format=yuv420p,trim=end_frame=${n},setpts=N/${FPS}/TB`
    );
  }
  // upscale 2x first: zoompan moves in whole pixels, the extra resolution removes the jitter
  const pre = `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},setsar=1`;
  const cy = 'ih/2-(ih/zoom/2)';
  const kind = MOTIONS[motionIdx % MOTIONS.length];
  const z = kind === 'in' ? `1+0.15*on/${n}` : kind === 'out' ? `1.15-0.15*on/${n}` : '1.15';
  const x = kind === 'right' ? `(iw-iw/zoom)*on/${n}` : kind === 'left' ? `(iw-iw/zoom)*(1-on/${n})` : 'iw/2-(iw/zoom/2)';
  return `${pre},zoompan=z='${z}':x='${x}':y='${cy}':d=${n}:s=${W}x${H}:fps=${FPS},format=yuv420p,trim=end_frame=${n},setpts=N/${FPS}/TB`;
}

function clipFilter(i, seconds) {
  const s = seconds.toFixed(2);
  return (
    `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=${s},trim=duration=${s},setpts=PTS-STARTPTS`
  );
}

// ---------------- background music ----------------
export function listMusic() {
  try {
    return fs
      .readdirSync(config.musicDir)
      .filter((f) => /\.(mp3|m4a)$/i.test(f))
      .map((f) => ({ name: f.replace(/\.(mp3|m4a)$/i, ''), file: path.join(config.musicDir, f) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Exact track name, or a mood prefix ("calm" -> one of calm-1, calm-2 …) picked at random. */
export function pickMusic(request) {
  const q = String(request || '').trim().toLowerCase();
  if (!q) return null;
  const all = listMusic();
  const exact = all.find((t) => t.name.toLowerCase() === q);
  if (exact) return exact;
  const pool = all.filter((t) => t.name.toLowerCase().startsWith(q));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

/** voice (or silence) + optional music that ducks under the voice and fades out -> [aout] */
function audioGraph({ voiceIdx, musicIdx, total }) {
  const fade = `afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5`;
  if (musicIdx === undefined) return `[${voiceIdx}:a]aresample=44100,apad[aout]`;
  if (voiceIdx === undefined) return `[${musicIdx}:a]aresample=44100,volume=0.35,${fade}[aout]`;
  return (
    `[${voiceIdx}:a]aresample=44100,aformat=channel_layouts=stereo,apad,asplit=2[vo][vk];` +
    `[${musicIdx}:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.30[m];` +
    `[m][vk]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[md];` +
    `[vo][md]amix=inputs=2:duration=first:normalize=0,${fade}[aout]`
  );
}

function encodeArgs(outFile, total, crf) {
  return [
    '-t', total.toFixed(2),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart',
    outFile,
  ];
}

/**
 * scenes:     [{ file, kind: 'image'|'video', seconds, caption? }]
 * voiceFile:  optional local audio path
 * words:      optional word timestamps of the voiceover -> word-by-word captions (scene captions ignored)
 * musicFile:  optional local music path
 * motion:     animate still images (zoom / pan)
 * title:      optional hook text at the top
 */
export async function renderShort({ scenes, voiceFile, words, musicFile, motion = true, title }) {
  if (!scenes.length) throw new StudioError('At least one scene is needed.');
  const plan = scenes.map((s) => ({ ...s }));

  if (voiceFile) {
    const voiceSeconds = await probeSeconds(voiceFile);
    const sceneTotal = plan.reduce((a, s) => a + s.seconds, 0);
    // The voiceover decides the length: stretch the last scene so speech is never cut off.
    if (voiceSeconds > sceneTotal) plan[plan.length - 1].seconds += voiceSeconds - sceneTotal + 0.3;
  }
  const total = Math.round(plan.reduce((a, s) => a + s.seconds, 0) * 100) / 100;
  if (total > config.maxShortSeconds) {
    throw new StudioError(
      `The video would be ${total.toFixed(1)}s long; this server allows at most ${config.maxShortSeconds}s. ` +
        'Use fewer/shorter scenes or a shorter voiceover text.',
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'short-'));
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    plan.forEach((s) => args.push('-i', s.file));
    let next = plan.length;
    let voiceIdx;
    let musicIdx;
    if (voiceFile) {
      args.push('-i', voiceFile);
      voiceIdx = next++;
    }
    if (musicFile) {
      args.push('-stream_loop', '-1', '-i', musicFile);
      musicIdx = next++;
    }
    if (voiceIdx === undefined && musicIdx === undefined) {
      args.push('-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo');
      voiceIdx = next++;
    }

    let stillNo = 0;
    const parts = plan.map(
      (s, i) => (s.kind === 'image' ? stillFilter(i, s.seconds, motion ? stillNo++ : -1) : clipFilter(i, s.seconds)) + `[v${i}]`,
    );
    let graph = parts.join(';') + ';' + plan.map((_, i) => `[v${i}]`).join('') + `concat=n=${plan.length}:v=1:a=0[vc]`;

    const cues = [];
    let wordCues = [];
    if (words?.length) wordCues = chunkWords(words);
    else {
      let t = 0;
      for (const s of plan) {
        if (s.caption && s.caption.trim()) cues.push({ start: t, end: t + s.seconds, text: s.caption });
        t += s.seconds;
      }
    }
    let vOut = '[vc]';
    if (cues.length || wordCues.length || title) {
      const assPath = path.join(tmp, 'captions.ass'); // tmp path has no characters ffmpeg would need escaped
      fs.writeFileSync(assPath, buildAss({ cues, wordCues, title, duration: total }));
      graph += `;[vc]subtitles=${assPath}[vs]`;
      vOut = '[vs]';
    }
    graph += ';' + audioGraph({ voiceIdx, musicIdx, total });

    const outFile = path.join(tmp, 'short.mp4');
    args.push('-filter_complex', graph, '-map', vOut, '-map', '[aout]', ...encodeArgs(outFile, total, 22));

    await acquire();
    try {
      await run(config.ffmpegPath, args, 270_000); // stay below LibreChat's 300 s MCP timeout
    } finally {
      release();
    }
    return { bytes: fs.readFileSync(outFile), seconds: total };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Cut [start, end] of a long source into a vertical 1080x1920 clip.
 * framing: 'center' (crop the middle) | 'fit' (whole frame over a blurred copy of itself)
 * words:   word timestamps relative to the SOURCE; only those inside the clip are used.
 */
export async function renderClip({ sourceFile, start, end, framing = 'center', words, title, musicFile }) {
  const dur = Math.round((end - start) * 100) / 100;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', start.toFixed(2), '-t', dur.toFixed(2), '-i', sourceFile];
    let musicIdx;
    if (musicFile) {
      args.push('-stream_loop', '-1', '-i', musicFile);
      musicIdx = 1;
    }
    let graph =
      framing === 'fit'
        ? `[0:v]split=2[bg][fg];` +
          `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:2,eq=brightness=-0.08[bgb];` +
          `[fg]scale=${W}:-2[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS},format=yuv420p[vc]`
        : `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p[vc]`;

    const inClip = (words || [])
      .filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05)
      .map((w) => ({ word: w.word, start: Math.max(0, w.start - start), end: Math.min(dur, w.end - start) }));
    let vOut = '[vc]';
    if (inClip.length || title) {
      const assPath = path.join(tmp, 'captions.ass');
      fs.writeFileSync(assPath, buildAss({ wordCues: chunkWords(inClip), title, duration: dur }));
      graph += `;[vc]subtitles=${assPath}[vs]`;
      vOut = '[vs]';
    }
    graph += ';' + audioGraph({ voiceIdx: 0, musicIdx, total: dur });

    const outFile = path.join(tmp, 'clip.mp4');
    args.push('-filter_complex', graph, '-map', vOut, '-map', '[aout]', ...encodeArgs(outFile, dur, 23));
    await acquire();
    try {
      await run(config.ffmpegPath, args, 240_000);
    } finally {
      release();
    }
    return { bytes: fs.readFileSync(outFile), seconds: dur };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}
