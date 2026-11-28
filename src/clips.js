// Long video -> clips.
//   startSource():  download the user's own long video from a direct / Google Drive / Dropbox link,
//                   extract the audio, transcribe it (word timestamps) through OpenRouter STT.
//                   Runs in the background; state lives in STATE_DIR/sources/<id>.json so a restart
//                   does not lose finished transcripts.
//   The agent reads the transcript, picks the best moments and calls cut_clips (renderClip).
//
// Download safety: https only, every redirect hop re-checked, and the TCP connection itself refuses
// private / loopback / link-local addresses (checked inside the DNS lookup, so DNS rebinding cannot
// slip through). Size and length are capped.

import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { transcribe } from './openrouter.js';
import { probe, run, StudioError } from './studio.js';

export class SourceError extends Error {}

const dir = () => path.join(config.stateDir, 'sources');
const metaPath = (id) => path.join(dir(), `${id}.json`);
export const videoPath = (id) => path.join(dir(), `${id}.mp4`);

function ensureDir() {
  fs.mkdirSync(dir(), { recursive: true });
}

export function readMeta(id) {
  if (!/^[a-f0-9]{24}$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(id, meta) {
  const tmp = metaPath(id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, metaPath(id));
}

export function cleanupSources() {
  ensureDir();
  const cutoff = Date.now() - config.sourceTtlHours * 3_600_000;
  for (const name of fs.readdirSync(dir())) {
    const p = path.join(dir(), name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** After a restart, jobs that were in progress can never finish: mark them failed so agents stop waiting. */
export function recoverSources() {
  ensureDir();
  for (const name of fs.readdirSync(dir())) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const meta = readMeta(id);
    if (meta && meta.status !== 'ready' && meta.status !== 'failed') {
      try {
        fs.unlinkSync(videoPath(id));
      } catch {
        /* ignore */
      }
      writeMeta(id, { ...meta, status: 'failed', error: 'The server restarted while processing. Please load the video again.' });
    }
  }
}

// ---------------- safe download ----------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const bad = addrs.find((a) => isPrivateIp(a.address));
    if (bad && !config.allowPrivateSourceUrls) return cb(new SourceError(`Address ${bad.address} is not allowed.`));
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

/** Share links -> direct download links (best effort). */
export function directUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new SourceError('That is not a valid link.');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'drive.google.com') {
    const id = u.pathname.match(/\/file\/d\/([^/]+)/)?.[1] || u.searchParams.get('id');
    if (id) return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
  }
  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)tiktok\.com$|(^|\.)instagram\.com$/.test(host)) {
    throw new SourceError(
      'Links to YouTube/TikTok/Instagram pages cannot be downloaded. Ask the user for their own video file as a ' +
        'direct link (Google Drive "anyone with the link", Dropbox, or any direct .mp4 link).',
    );
  }
  return u.toString();
}

function download(url, file, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new SourceError('Invalid download link.'));
    }
    const isHttps = u.protocol === 'https:';
    if (!isHttps && !(u.protocol === 'http:' && config.allowPrivateSourceUrls)) {
      return reject(new SourceError('Only https:// links are accepted.'));
    }
    const lib = isHttps ? https : http;
    const req = lib.get(u, { lookup: safeLookup, timeout: 30_000, headers: { 'User-Agent': 'VelorafyClipper/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!redirectsLeft) return reject(new SourceError('Too many redirects.'));
        const next = new URL(res.headers.location, u).toString();
        return download(next, file, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new SourceError(`The link answered HTTP ${res.statusCode}. Make sure it is public and points to the video file.`));
      }
      const type = String(res.headers['content-type'] || '');
      if (/text\/html/i.test(type)) {
        res.resume();
        return reject(
          new SourceError('The link opens a web page, not a video file. For Google Drive, set sharing to "Anyone with the link".'),
        );
      }
      const max = config.maxSourceMb * 1024 * 1024;
      if (Number(res.headers['content-length']) > max) {
        res.resume();
        return reject(new SourceError(`The file is larger than ${config.maxSourceMb} MB.`));
      }
      let got = 0;
      const out = fs.createWriteStream(file);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (got > max) {
          req.destroy(new SourceError(`The file is larger than ${config.maxSourceMb} MB.`));
        }
      });
      res.pipe(out);
      out.on('finish', () => resolve(got));
      res.on('error', reject);
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new SourceError('The download stalled.')));
    req.on('error', (e) => reject(e instanceof SourceError ? e : new SourceError(`Download failed: ${e.message}`)));
  });
}

// ---------------- transcription ----------------
// OpenRouter's upstream STT providers time out after ~60 s per request, so long audio is split
// into short chunks and sent a few at a time. 32 kbps mono -> ~1.9 MB per 8-minute chunk.
const CHUNK_SECONDS = 8 * 60;
const STT_PARALLEL = 3;

/** Some providers return segments but no word timestamps: spread each segment's words over its time. */
export function wordsFromSegments(segments) {
  const out = [];
  for (const s of segments || []) {
    const tokens = String(s.text || '').trim().split(/\s+/).filter(Boolean);
    const span = Math.max(0.01, s.end - s.start);
    const totalChars = tokens.reduce((a, t) => a + t.length, 0) || 1;
    let t = s.start;
    for (const tok of tokens) {
      const d = (span * tok.length) / totalChars;
      out.push({ word: tok, start: +t.toFixed(2), end: +(t + d).toFixed(2) });
      t += d;
    }
  }
  return out;
}

async function transcribeWithRetry(args) {
  try {
    return await transcribe(args);
  } catch (err) {
    if (err?.status && err.status < 500 && err.status !== 408 && err.status !== 429) throw err;
    await new Promise((r) => setTimeout(r, 3000));
    return transcribe(args);
  }
}

async function transcribeFile(videoFile, language) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stt-'));
  try {
    await run(
      config.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
        '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1', path.join(tmp, 'part%03d.mp3')],
      15 * 60_000,
    );
    const parts = fs.readdirSync(tmp).filter((f) => f.endsWith('.mp3')).sort().map((f) => path.join(tmp, f));
    // real chunk lengths (segment cuts land on audio frames, not exactly on CHUNK_SECONDS)
    const offsets = [];
    let acc = 0;
    for (const p of parts) {
      offsets.push(acc);
      acc += (await probe(p)).seconds || CHUNK_SECONDS;
    }
    const results = new Array(parts.length);
    let next = 0;
    const worker = async () => {
      while (next < parts.length) {
        const i = next++;
        results[i] = await transcribeWithRetry({ bytes: fs.readFileSync(parts[i]), format: 'mp3', language });
      }
    };
    await Promise.all(Array.from({ length: Math.min(STT_PARALLEL, parts.length) }, worker));

    const words = [];
    const segments = [];
    let cost = 0;
    let lang;
    results.forEach((r, i) => {
      const offset = offsets[i];
      lang ??= r.language;
      cost += Number(r.usage?.cost) || 0;
      const segs = (r.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text).trim() }));
      const ws = r.words?.length ? r.words : wordsFromSegments(segs);
      for (const w of ws) words.push({ word: w.word, start: +(w.start + offset).toFixed(2), end: +(w.end + offset).toFixed(2) });
      for (const s of segs) segments.push({ start: +(s.start + offset).toFixed(2), end: +(s.end + offset).toFixed(2), text: s.text });
    });
    return { words, segments, cost, language: lang };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Transcribe an audio file this server made (voiceover) -> word timestamps. */
export async function transcribeVoice(file, language) {
  const r = await transcribeWithRetry({ bytes: fs.readFileSync(file), format: path.extname(file).slice(1) || 'mp3', language });
  const words = r.words?.length ? r.words : wordsFromSegments(r.segments);
  return { words: words.map((w) => ({ word: w.word, start: w.start, end: w.end })), cost: Number(r.usage?.cost) || 0 };
}

// ---------------- jobs ----------------
const running = new Map(); // id -> promise

/**
 * hooks.check(minutes) -> { ok, message?, release() }   reserves credit/quota once the length is known
 * hooks.done(minutes)                                   records usage + charge
 */
export function startSource({ userId, url, language, hooks }) {
  ensureDir();
  cleanupSources();
  const id = crypto.randomBytes(12).toString('hex');
  const meta = { id, userId, status: 'downloading', createdAt: new Date().toISOString() };
  writeMeta(id, meta);
  const job = (async () => {
    let hold;
    try {
      const file = videoPath(id);
      await download(directUrl(url), file);
      const info = await probe(file).catch(() => ({}));
      if (!info.hasVideo || !info.hasAudio) throw new SourceError('The file is not a video with sound.');
      const minutes = Math.ceil(info.seconds / 60);
      if (minutes > config.maxSourceMinutes) throw new SourceError(`The video is ${minutes} min long; the limit is ${config.maxSourceMinutes} min.`);
      hold = await hooks.check(minutes);
      if (!hold.ok) throw new SourceError(hold.message);
      writeMeta(id, { ...meta, status: 'transcribing', seconds: info.seconds, width: info.width, height: info.height });
      const t = await transcribeFile(file, language);
      if (!t.segments.length && !t.words.length) throw new SourceError('No speech was found in this video.');
      hooks.done(minutes, t.cost);
      writeMeta(id, { ...meta, status: 'ready', seconds: info.seconds, width: info.width, height: info.height, language: t.language, words: t.words, segments: t.segments });
    } catch (err) {
      try {
        fs.unlinkSync(videoPath(id));
      } catch {
        /* ignore */
      }
      const message = err instanceof SourceError || err instanceof StudioError ? err.message : `Processing failed: ${err?.message || err}`;
      if (!(err instanceof SourceError)) console.error('[source]', err);
      writeMeta(id, { ...meta, status: 'failed', error: message });
    } finally {
      hold?.release?.();
      running.delete(id);
    }
  })();
  running.set(id, job);
  return id;
}

/** Wait up to `seconds` for a job to settle; returns current meta. */
export async function waitSource(id, seconds) {
  const job = running.get(id);
  if (job) await Promise.race([job, new Promise((r) => setTimeout(r, seconds * 1000))]);
  return readMeta(id);
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Compact transcript for the agent: "[m:ss-m:ss] text" lines, capped. */
export function transcriptText(meta, maxChars = 60_000) {
  let lines = meta.segments.map((s) => `[${mmss(s.start)}-${mmss(s.end)}] ${s.text}`);
  if (!lines.length) {
    // provider gave words only: build ~10 s lines from them
    let cur = [];
    for (const w of meta.words) {
      cur.push(w);
      if (w.end - cur[0].start >= 10) {
        lines.push(`[${mmss(cur[0].start)}-${mmss(w.end)}] ${cur.map((x) => x.word).join(' ')}`);
        cur = [];
      }
    }
    if (cur.length) lines.push(`[${mmss(cur[0].start)}-${mmss(cur[cur.length - 1].end)}] ${cur.map((x) => x.word).join(' ')}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n[… transcript truncated]';
  return text;
}
