// Media files, per-user daily quotas, video job ownership and a usage log.
// Everything is plain files under MEDIA_DIR / STATE_DIR so a Docker volume keeps it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
};

export function initStorage() {
  fs.mkdirSync(config.mediaDir, { recursive: true });
  fs.mkdirSync(config.stateDir, { recursive: true });
}

/** Saves bytes under an unguessable name and returns { fileName, url }. */
export function saveMedia(bytes, mimeType) {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  const ext = EXT[base] || 'bin';
  const fileName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(config.mediaDir, fileName), bytes);
  const url = config.publicBaseUrl ? `${config.publicBaseUrl}/media/${fileName}` : undefined;
  return { fileName, url };
}

export function cleanupOldMedia() {
  if (config.mediaTtlDays <= 0) return 0;
  const cutoff = Date.now() - config.mediaTtlDays * 86_400_000;
  let removed = 0;
  for (const name of fs.readdirSync(config.mediaDir)) {
    const p = path.join(config.mediaDir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) {
        fs.unlinkSync(p);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

// ---- small JSON state (quotas + video jobs) -------------------------------

const statePath = () => path.join(config.stateDir, 'state.json');
let state = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    state = {};
  }
  state.usage ??= {}; // { "2026-11-26": { "<userId>": { image: 3, video: 1, tts: 0 } } }
  state.jobs ??= {}; // { "<jobId>": { userId, model, createdAt, fileName?, url? } }
  return state;
}

function save() {
  const tmp = `${statePath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath());
}

const today = () => new Date().toISOString().slice(0, 10);

const LIMITS = {
  image: () => config.limitImagesPerDay,
  video: () => config.limitVideosPerDay,
  tts: () => config.limitTtsPerDay,
};

/** Returns { ok, used, limit }. Does not consume. */
export function checkQuota(userId, kind, amount = 1) {
  const s = load();
  const limit = LIMITS[kind]();
  const used = s.usage[today()]?.[userId]?.[kind] ?? 0;
  return { ok: limit > 0 && used + amount <= limit, used, limit };
}

export function consumeQuota(userId, kind, amount = 1) {
  const s = load();
  const day = today();
  // keep only the last 3 days of counters
  const oldest = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  for (const d of Object.keys(s.usage)) if (d < oldest) delete s.usage[d];
  s.usage[day] ??= {};
  s.usage[day][userId] ??= {};
  s.usage[day][userId][kind] = (s.usage[day][userId][kind] ?? 0) + amount;
  save();
}

export function rememberJob(jobId, info) {
  const s = load();
  s.jobs[jobId] = { ...info, createdAt: Date.now() };
  // drop jobs older than 7 days
  for (const [id, j] of Object.entries(s.jobs)) {
    if (Date.now() - (j.createdAt ?? 0) > 7 * 86_400_000) delete s.jobs[id];
  }
  save();
}

export function getJob(jobId) {
  return load().jobs[jobId];
}

export function updateJob(jobId, patch) {
  const s = load();
  if (s.jobs[jobId]) {
    Object.assign(s.jobs[jobId], patch);
    save();
  }
}

/** Append-only usage log: one JSON line per paid call, for your own accounting. */
export function logUsage(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(path.join(config.stateDir, 'usage.jsonl'), line);
}
