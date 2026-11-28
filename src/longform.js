// Long horizontal videos (YouTube "explainer" / history-channel style) and thumbnails.
//
// assemble_long: sections, each = one voiceover + a few images/clips shown in order while that
// voice plays -> one 1920x1080 MP4 (5-20 min). Rendering takes minutes on a small VPS, so it runs
// in the background: each section is rendered to its own segment (taking the shared render slot
// only for that section, so Shorts can still squeeze in between), then the segments are joined
// without re-encoding the picture; background music is mixed in during the join.
// Job state lives in STATE_DIR/longs/<id>.json so the agent can poll it with get_long_video.
//
// make_thumbnail: 1280x720 JPEG (YouTube's size, < 2 MB) with big outlined text drawn by sharp.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { acquire, release, run, probeSeconds, StudioError } from './studio.js';
import { transcribeVoice } from './clips.js';
import { saveMediaFile } from './storage.js';

export const LW = 1920;
export const LH = 1080;
const SECTION_TAIL = 0.6; // breathing room after each section's voice

// ---------------- job files ----------------
const dir = () => path.join(config.stateDir, 'longs');
const jobPath = (id) => path.join(dir(), `${id}.json`);
const ensureDir = () => fs.mkdirSync(dir(), { recursive: true });

export function readLong(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function writeLong(job) {
  ensureDir();
  const tmp = jobPath(job.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(job));
  fs.renameSync(tmp, jobPath(job.id));
}

/** After a restart, renders that were in progress can never finish. */
export function recoverLongs(onFail) {
  ensureDir();
  const cutoff = Date.now() - 14 * 86_400_000;
  for (const name of fs.readdirSync(dir())) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(dir(), name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.unlinkSync(p);
        continue;
      }
    } catch {
      continue;
    }
    const job = readLong(name.slice(0, -5));
    if (job && job.status !== 'ready' && job.status !== 'failed') {
      writeLong({ ...job, status: 'failed', error: 'The server restarted during rendering. Please start the video again.' });
      onFail?.(job);
    }
  }
}

// ---------------- subtitles ----------------
const assTime = (sec) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};
const assText = (t) => String(t).replace(/\\/g, '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();

/** Word timestamps -> readable subtitle lines (max ~55 chars / 4.5 s, break after sentences). */
export function subtitleLines(words) {
  const lines = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(' ') });
    cur = [];
  };
  for (const w of words) {
    const t = String(w.word ?? '').trim();
    if (!t || !(w.end >= w.start)) continue;
    const len = cur.reduce((a, x) => a + x.text.length + 1, 0);
    if (cur.length && (len + t.length > 55 || w.end - cur[0].start > 4.5)) flush();
    cur.push({ text: t, start: w.start, end: w.end });
    const curLen = cur.reduce((a, x) => a + x.text.length + 1, 0);
    if (/[.!?…]$/.test(t) && curLen >= 15) flush();
  }
  flush();
  // keep each line up a little after the last word, but never over the next one
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]?.start ?? Infinity;
    lines[i].end = Math.min(lines[i].end + 0.3, next - 0.02);
  }
  return lines;
}

function sectionAss({ lines, heading, title, duration }) {
  const f = config.captionFont;
  const out = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${LW}`,
    `PlayResY: ${LH}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sub,${f},62,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1.5,2,200,200,64,1`,
    `Style: Head,${f},54,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,3,16,0,7,70,70,60,1`,
    `Style: Title,${f},104,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,5,160,160,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  if (title) out.push(`Dialogue: 2,${assTime(0.2)},${assTime(Math.min(4.5, duration))},Title,,0,0,0,,{\\fad(400,400)}${assText(title)}`);
  if (heading) {
    const from = title ? 4.6 : 0.2;
    if (from + 1 < duration) out.push(`Dialogue: 1,${assTime(from)},${assTime(Math.min(from + 3.5, duration))},Head,,0,0,0,,{\\fad(300,300)}${assText(heading)}`);
  }
  for (const l of lines) if (l.end > l.start) out.push(`Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Sub,,0,0,0,,${assText(l.text)}`);
  return out.join('\n') + '\n';
}

// ---------------- pictures ----------------

/** Fit any image into w x h: cover-crop when the shape is close, else whole image over a blurred copy. */
async function prepareFrame(file, out, w, h) {
  const meta = await sharp(file).rotate().metadata();
  const iw = meta.autoOrient?.width ?? meta.width;
  const ih = meta.autoOrient?.height ?? meta.height;
  const target = w / h;
  const ratio = iw && ih ? iw / ih : target;
  if (Math.abs(ratio - target) / target < 0.2) {
    await sharp(file).rotate().resize(w, h, { fit: 'cover' }).jpeg({ quality: 92 }).toFile(out);
    return;
  }
  const bg = await sharp(file)
    .rotate()
    .resize(Math.round(w / 10), Math.round(h / 10), { fit: 'cover' })
    .blur(2)
    .modulate({ brightness: 0.75 })
    .resize(w, h)
    .toBuffer();
  const fg = await sharp(file).rotate().resize(w, h, { fit: 'inside' }).toBuffer();
  await sharp(bg).composite([{ input: fg, gravity: 'center' }]).jpeg({ quality: 92 }).toFile(out);
}

const MOVES = ['in', 'right', 'out', 'left'];
function stillFilter(i, seconds, moveIdx, fps) {
  const n = Math.max(1, Math.round(seconds * fps));
  if (moveIdx < 0) {
    return `[${i}:v]setsar=1,loop=loop=${n - 1}:size=1:start=0,fps=${fps},format=yuv420p,trim=end_frame=${n},setpts=N/${fps}/TB`;
  }
  // input is 2x the output size: zoompan moves in whole pixels, the extra resolution hides the jitter
  const kind = MOVES[moveIdx % MOVES.length];
  const z = kind === 'in' ? `1+0.10*on/${n}` : kind === 'out' ? `1.10-0.10*on/${n}` : '1.10';
  const x = kind === 'right' ? `(iw-iw/zoom)*on/${n}` : kind === 'left' ? `(iw-iw/zoom)*(1-on/${n})` : 'iw/2-(iw/zoom/2)';
  return `[${i}:v]setsar=1,zoompan=z='${z}':x='${x}':y='ih/2-(ih/zoom/2)':d=${n}:s=${LW}x${LH}:fps=${fps},format=yuv420p,trim=end_frame=${n},setpts=N/${fps}/TB`;
}

function clipFilter(i, seconds, fps) {
  const s = seconds.toFixed(2);
  return (
    `[${i}:v]scale=${LW}:${LH}:force_original_aspect_ratio=increase,crop=${LW}:${LH},setsar=1,fps=${fps},format=yuv420p,` +
    `tpad=stop_mode=clone:stop_duration=${s},trim=duration=${s},setpts=PTS-STARTPTS`
  );
}

// ---------------- planning ----------------

/**
 * sections: [{ voiceFile, items: [{ file, kind: 'image'|'video' }], heading? }]
 * Returns the sections with lengths, or throws StudioError with a message for the agent.
 */
export async function planLong(sections) {
  const planned = [];
  let total = 0;
  for (const [i, s] of sections.entries()) {
    const voiceSeconds = await probeSeconds(s.voiceFile);
    const seconds = Math.round((voiceSeconds + SECTION_TAIL) * 100) / 100;
    const per = seconds / s.items.length;
    if (per < 1.5) {
      throw new StudioError(`Section ${i + 1}: ${s.items.length} pictures for ${voiceSeconds.toFixed(0)}s of voice is too many (each would show < 1.5 s). Use fewer pictures.`);
    }
    planned.push({ ...s, voiceSeconds, seconds });
    total += seconds;
  }
  if (total > config.maxLongMinutes * 60) {
    throw new StudioError(
      `The video would be ${(total / 60).toFixed(1)} min long; this server allows at most ${config.maxLongMinutes} min. Shorten the script.`,
    );
  }
  return { sections: planned, seconds: Math.round(total * 10) / 10 };
}

async function renderSection(sec, idx, { tmp, motion, subtitles, language, title, fps, onStt }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const per = sec.seconds / sec.items.length;
  let moveNo = idx * 3; // vary the first move between sections
  const parts = [];
  for (const [j, it] of sec.items.entries()) {
    const seconds = j === sec.items.length - 1 ? sec.seconds - per * (sec.items.length - 1) : per;
    if (it.kind === 'image') {
      const frame = path.join(tmp, `s${idx}_${j}.jpg`);
      await prepareFrame(it.file, frame, motion ? LW * 2 : LW, motion ? LH * 2 : LH);
      args.push('-i', frame);
      parts.push(stillFilter(j, seconds, motion ? moveNo++ : -1, fps) + `[v${j}]`);
    } else {
      args.push('-i', it.file);
      parts.push(clipFilter(j, seconds, fps) + `[v${j}]`);
    }
  }
  const voiceIdx = sec.items.length;
  args.push('-i', sec.voiceFile);
  let graph = parts.join(';') + ';' + sec.items.map((_, j) => `[v${j}]`).join('') + `concat=n=${sec.items.length}:v=1:a=0[vc]`;

  let lines = [];
  if (subtitles) {
    try {
      const r = await transcribeVoice(sec.voiceFile, language);
      onStt(r.cost);
      lines = subtitleLines(r.words);
    } catch (err) {
      console.error('[long stt]', err?.message || err);
    }
  }
  let vOut = '[vc]';
  const sectionTitle = idx === 0 ? title : undefined;
  if (lines.length || sec.heading || sectionTitle) {
    const assPath = path.join(tmp, `s${idx}.ass`);
    fs.writeFileSync(assPath, sectionAss({ lines, heading: sec.heading, title: sectionTitle, duration: sec.seconds }));
    graph += `;[vc]subtitles=${assPath}[vs]`;
    vOut = '[vs]';
  }
  graph += `;[${voiceIdx}:a]aresample=44100,aformat=channel_layouts=stereo,apad[aout]`;
  const out = path.join(tmp, `seg${String(idx).padStart(3, '0')}.mp4`);
  args.push(
    '-filter_complex', graph, '-map', vOut, '-map', '[aout]',
    '-t', sec.seconds.toFixed(2),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-g', String(fps * 4), '-video_track_timescale', '90000',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
    out,
  );
  await acquire(45 * 60_000);
  try {
    await run(config.ffmpegPath, args, Math.max(180_000, sec.seconds * 8000));
  } finally {
    release();
  }
  return out;
}

async function joinSegments(segments, { tmp, musicFile, total }) {
  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, segments.map((s) => `file '${s}'`).join('\n') + '\n');
  const out = path.join(tmp, 'long.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  if (musicFile) {
    args.push('-stream_loop', '-1', '-i', musicFile);
    const fade = `afade=t=out:st=${Math.max(0, total - 3).toFixed(2)}:d=3`;
    args.push(
      '-filter_complex',
      `[0:a]aresample=44100,aformat=channel_layouts=stereo,asplit=2[vo][vk];` +
        `[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=0.22[m];` +
        `[m][vk]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=400[md];` +
        `[vo][md]amix=inputs=2:duration=first:normalize=0,${fade}[aout]`,
      '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    );
  } else {
    args.push('-c', 'copy');
  }
  args.push('-movflags', '+faststart', out);
  await run(config.ffmpegPath, args, Math.max(300_000, total * 2000));
  return out;
}

// ---------------- background jobs ----------------
const runningJobs = new Map(); // id -> promise

export function activeLongFor(userId) {
  for (const id of runningJobs.keys()) if (readLong(id)?.userId === userId) return id;
  return null;
}

/**
 * plan: result of planLong()
 * hooks.onStt(cost)          charge speech-recognition cost as it happens
 * hooks.done(job) / fail(job) bookkeeping when the render finishes
 */
export function startLong({ userId, plan, motion = true, subtitles = true, language, musicFile, title, hooks = {} }) {
  ensureDir();
  const id = crypto.randomBytes(12).toString('hex');
  const n = plan.sections.length;
  const base = { id, userId, status: 'queued', progress: `0/${n} sections`, seconds: plan.seconds, createdAt: new Date().toISOString() };
  writeLong(base);
  const fps = config.longFps;
  const job = (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'long-'));
    try {
      const segments = [];
      for (const [i, sec] of plan.sections.entries()) {
        writeLong({ ...base, status: 'rendering', progress: `${i}/${n} sections` });
        segments.push(await renderSection(sec, i, { tmp, motion, subtitles, language, title, fps, onStt: (c) => hooks.onStt?.(c) }));
      }
      writeLong({ ...base, status: 'joining', progress: `${n}/${n} sections` });
      const out = await joinSegments(segments, { tmp, musicFile, total: plan.seconds });
      const saved = saveMediaFile(out, 'mp4');
      const done = { ...base, status: 'ready', progress: `${n}/${n} sections`, fileName: saved.fileName, url: saved.url, finishedAt: new Date().toISOString() };
      writeLong(done);
      hooks.done?.(done);
    } catch (err) {
      const message = err instanceof StudioError ? err.message : `Rendering failed: ${err?.message || err}`;
      console.error('[long]', err?.message || err);
      const failed = { ...base, status: 'failed', error: message };
      writeLong(failed);
      hooks.fail?.(failed);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      runningJobs.delete(id);
    }
  })();
  runningJobs.set(id, job);
  return id;
}

export async function waitLong(id, seconds) {
  const job = runningJobs.get(id);
  if (job) {
    let timer;
    await Promise.race([job, new Promise((r) => (timer = setTimeout(r, seconds * 1000)))]);
    clearTimeout(timer);
  }
  return readLong(id);
}

// ---------------- thumbnails ----------------
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const THUMB_COLORS = { yellow: '#FFD60A', white: '#FFFFFF', red: '#FF3B30', green: '#34C759', orange: '#FF9500', cyan: '#32D2FF' };

/** "How *Rome* fell" -> [[{t:'How',hi:false},{t:'Rome',hi:true}], …] wrapped into lines. */
function layoutWords(raw, maxChars) {
  const words = [];
  for (const m of String(raw).matchAll(/\*([^*]+)\*|(\S+)/g)) {
    if (m[1]) for (const t of m[1].trim().split(/\s+/)) words.push({ t, hi: true });
    else words.push({ t: m[2], hi: false });
  }
  const lines = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    if (cur.length && len + 1 + w.t.length > maxChars) {
      lines.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(w);
    len += (cur.length > 1 ? 1 : 0) + w.t.length;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * file: background image; text: up to ~60 chars, *word* = accent colour.
 * position: left | right | center | top | bottom
 */
export async function renderThumbnail({ file, text, position = 'left', color = 'yellow', uppercase = true }) {
  const W = 1280;
  const H = 720;
  const accent = THUMB_COLORS[color] || THUMB_COLORS.yellow;
  const body = uppercase ? text.toLocaleUpperCase() : text;
  const side = position === 'left' || position === 'right';
  const boxW = side ? W * 0.6 : W * 0.9;

  // biggest font that fits in <= 3 lines (DejaVu Sans Bold ~0.62 em per char)
  let size = 120;
  let lines;
  for (; size >= 56; size -= 6) {
    const maxChars = Math.max(4, Math.floor(boxW / (size * 0.62)));
    lines = layoutWords(body, maxChars);
    const widest = Math.max(...lines.map((l) => l.reduce((a, w) => a + w.t.length + 1, -1)));
    if (lines.length <= 3 && widest * size * 0.62 <= boxW) break;
  }
  if (size < 56) {
    size = 56;
    lines = layoutWords(body, Math.floor(boxW / (size * 0.62))).slice(0, 3);
  }
  const lineH = size * 1.12;
  const blockH = lineH * lines.length;
  const anchor = position === 'left' ? 'start' : position === 'right' ? 'end' : 'middle';
  const x = position === 'left' ? 56 : position === 'right' ? W - 56 : W / 2;
  const top = position === 'top' ? 50 : position === 'bottom' ? H - 50 - blockH : (H - blockH) / 2;

  const tspans = (l) => l.map((w, i) => `<tspan fill="${w.hi ? accent : '#FFFFFF'}">${i ? ' ' : ''}${xmlEsc(w.t)}</tspan>`).join('');
  const textEls = lines
    .map((l, i) => {
      const y = top + lineH * i + size * 0.9;
      const common = `x="${x}" y="${y.toFixed(1)}" text-anchor="${anchor}" xml:space="preserve" font-family="${xmlEsc(config.captionFont)}" font-weight="bold" font-size="${size}"`;
      // stroke copy underneath, fill copy on top (works on every librsvg version)
      return (
        `<text ${common} fill="#000" stroke="#000" stroke-width="${Math.round(size / 7)}" stroke-linejoin="round">${xmlEsc(l.map((w) => w.t).join(' '))}</text>` +
        `<text ${common}>${tspans(l)}</text>`
      );
    })
    .join('');
  const grad = {
    left: '<linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.75"/><stop offset="0.65" stop-color="#000" stop-opacity="0"/></linearGradient>',
    right: '<linearGradient id="g" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.75"/><stop offset="0.65" stop-color="#000" stop-opacity="0"/></linearGradient>',
    top: '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.7"/><stop offset="0.6" stop-color="#000" stop-opacity="0"/></linearGradient>',
    bottom: '<linearGradient id="g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.7"/><stop offset="0.6" stop-color="#000" stop-opacity="0"/></linearGradient>',
    center: '<radialGradient id="g"><stop offset="0" stop-color="#000" stop-opacity="0.45"/><stop offset="1" stop-color="#000" stop-opacity="0.15"/></radialGradient>',
  }[position];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${grad}</defs><rect width="${W}" height="${H}" fill="url(#g)"/>${textEls}</svg>`;

  const bg = await sharp(file).rotate().resize(W, H, { fit: 'cover' }).toBuffer();
  let quality = 90;
  let out;
  do {
    out = await sharp(bg).composite([{ input: Buffer.from(svg) }]).jpeg({ quality, mozjpeg: true }).toBuffer();
    quality -= 8;
  } while (out.length > 1_900_000 && quality > 50); // YouTube's thumbnail limit is 2 MB
  return out;
}
