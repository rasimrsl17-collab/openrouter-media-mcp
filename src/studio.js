// assemble_short: turns scenes (images / video clips made by this server) + an optional
// voiceover + per-scene captions into one vertical 1080x1920 MP4 ready for
// YouTube Shorts, TikTok and Reels. Pure ffmpeg, no paid API.
//
// Only files this server saved itself (PUBLIC_BASE_URL/media/...) are accepted as inputs,
// so the tool can never be used to fetch arbitrary URLs from the VPS.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';

const W = 1080;
const H = 1920;
const FPS = 30;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXT = new Set(['.mp3', '.wav']);

export class StudioError extends Error {}

// ---- tiny semaphore: a 1-2 vCPU droplet should not encode many videos at once ----
let running = 0;
const waiting = [];
async function acquire() {
  if (running < Math.max(1, config.maxConcurrentRenders)) {
    running++;
    return;
  }
  await new Promise((r) => waiting.push(r));
  running++;
}
function release() {
  running--;
  waiting.shift()?.();
}

function run(cmd, args, timeoutMs) {
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

export async function probeSeconds(file) {
  const out = await run(
    config.ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    30_000,
  );
  const s = Number(out.trim());
  if (!Number.isFinite(s) || s <= 0) throw new StudioError('Could not read the length of the voiceover file.');
  return s;
}

// ---- captions as an ASS subtitle file (big, bold, outlined, lower third) ----
const assTime = (sec) => {
  const cs = Math.round(sec * 100);
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

function buildAss(cues) {
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
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = cues.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${assText(c.text)}`);
  return head.concat(lines).join('\n') + '\n';
}

/**
 * scenes: [{ file, kind: 'image'|'video', seconds, caption? }]
 * voiceFile: optional local mp3/wav path
 * Returns { bytes, seconds }.
 */
export async function renderShort({ scenes, voiceFile }) {
  if (!scenes.length) throw new StudioError('At least one scene is needed.');
  const plan = scenes.map((s) => ({ ...s }));

  let voiceSeconds = 0;
  if (voiceFile) {
    voiceSeconds = await probeSeconds(voiceFile);
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
    plan.forEach((s) => {
      if (s.kind === 'image') args.push('-loop', '1', '-framerate', String(FPS), '-t', s.seconds.toFixed(2), '-i', s.file);
      else args.push('-i', s.file);
    });
    const audioIdx = plan.length;
    if (voiceFile) args.push('-i', voiceFile);
    else args.push('-f', 'lavfi', '-t', total.toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo');

    const parts = plan.map(
      (s, i) =>
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS},format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${s.seconds.toFixed(2)},trim=duration=${s.seconds.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`,
    );
    let graph = parts.join(';') + ';' + plan.map((_, i) => `[v${i}]`).join('') + `concat=n=${plan.length}:v=1:a=0[vc]`;

    // captions: each scene's caption is shown for the whole scene
    const cues = [];
    let t = 0;
    for (const s of plan) {
      if (s.caption && s.caption.trim()) cues.push({ start: t, end: t + s.seconds, text: s.caption });
      t += s.seconds;
    }
    let vOut = '[vc]';
    if (cues.length) {
      const assPath = path.join(tmp, 'captions.ass'); // tmp path has no characters ffmpeg would need escaped
      fs.writeFileSync(assPath, buildAss(cues));
      graph += `;[vc]subtitles=${assPath}[vs]`;
      vOut = '[vs]';
    }
    graph += `;[${audioIdx}:a]aresample=44100,apad[aout]`;

    const outFile = path.join(tmp, 'short.mp4');
    args.push(
      '-filter_complex', graph,
      '-map', vOut, '-map', '[aout]',
      '-t', total.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
      '-movflags', '+faststart',
      outFile,
    );

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

export function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}
