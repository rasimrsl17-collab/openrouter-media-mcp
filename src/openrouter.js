// Thin client for the OpenRouter media endpoints.
// Request/response shapes follow https://openrouter.ai/docs (multimodal guides):
//   POST /images                    -> { data: [{ b64_json | url, media_type }], usage: { cost } }
//   POST /videos                    -> 202 { id, polling_url, status: "pending" }
//   GET  /videos/{id}               -> { id, status, unsigned_urls, urls?, usage, error? }
//   GET  /videos/{id}/content?index -> binary video (404 before "completed")
//   POST /audio/speech              -> raw audio bytes (audio/mpeg for mp3), JSON on error
//   GET  /images/models, /videos/models, /models?output_modalities=speech

import { config } from './config.js';

export class OpenRouterError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function headers(json = true) {
  const h = {
    Authorization: `Bearer ${config.openrouterKey}`,
    'X-Title': 'Velorafy Media Tools',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function readError(res) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const msg =
    (body && typeof body === 'object' && (body.error?.message || body.message)) ||
    (typeof body === 'string' && body.slice(0, 500)) ||
    `HTTP ${res.status}`;
  return new OpenRouterError(res.status, msg, body);
}

async function request(path, { method = 'GET', body, timeoutMs = 180_000 } = {}) {
  const res = await fetch(`${config.openrouterBaseUrl}${path}`, {
    method,
    headers: headers(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res;
}

export async function generateImages(params) {
  const res = await request('/images', { method: 'POST', body: params });
  if (!res.ok) throw await readError(res);
  return res.json();
}

/** Downloads an image given as a URL (used when the API returns url instead of b64_json). */
export async function fetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new OpenRouterError(res.status, `Download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function submitVideo(params) {
  const res = await request('/videos', { method: 'POST', body: params });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function getVideoJob(jobId) {
  const res = await request(`/videos/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function downloadVideo(jobId, index = 0) {
  const res = await request(`/videos/${encodeURIComponent(jobId)}/content?index=${index}`, {
    timeoutMs: 300_000,
  });
  if (!res.ok) throw await readError(res);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'video/mp4',
  };
}

export async function synthesizeSpeech(params) {
  const res = await request('/audio/speech', { method: 'POST', body: params });
  if (!res.ok) throw await readError(res);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'audio/mpeg',
    generationId: res.headers.get('x-generation-id') || undefined,
  };
}

export async function listImageModels() {
  const res = await request('/images/models');
  if (!res.ok) throw await readError(res);
  return (await res.json()).data ?? [];
}

export async function listVideoModels() {
  const res = await request('/videos/models');
  if (!res.ok) throw await readError(res);
  const json = await res.json();
  return json.data ?? json.models ?? [];
}

export async function listSpeechModels() {
  const res = await request('/models?output_modalities=speech');
  if (!res.ok) throw await readError(res);
  return (await res.json()).data ?? [];
}

/**
 * Speech-to-text with word timestamps.
 * POST /audio/transcriptions  { model, input_audio: { data(base64), format }, response_format: 'verbose_json',
 *   timestamp_granularities: ['word','segment'], language? }
 *   -> { text, words?: [{ word, start, end }], segments?: [{ start, end, text }], duration?, usage?: { cost, seconds } }
 */
export async function transcribe({ bytes, format, language }) {
  const body = {
    model: config.sttModel,
    input_audio: { data: bytes.toString('base64'), format },
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
  };
  if (language && /^[a-z]{2}/i.test(language)) body.language = language.slice(0, 2).toLowerCase(); // ISO-639-1 only
  const res = await request('/audio/transcriptions', { method: 'POST', body, timeoutMs: 280_000 });
  if (!res.ok) throw await readError(res);
  return res.json();
}

/**
 * Music (Google Lyria 3 and other audio-output chat models).
 * POST /chat/completions { model, messages, modalities: ['text','audio'], audio: { format }, stream: true }
 * Audio arrives in SSE chunks as choices[0].delta.audio.data (base64); usage.cost in the last chunk.
 * A non-streamed JSON answer (message.audio.data) is accepted too.
 */
export async function generateMusic({ model, prompt, format = 'mp3' }) {
  const res = await fetch(`${config.openrouterBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], modalities: ['text', 'audio'], audio: { format }, stream: true, usage: { include: true } }),
    signal: AbortSignal.timeout(280_000),
  });
  if (!res.ok) throw await readError(res);
  const parts = [];
  let transcript = '';
  let cost = null;
  let fmt = null;
  const take = (obj) => {
    if (obj?.error) throw new OpenRouterError(502, obj.error.message || JSON.stringify(obj.error), obj);
    const ch = obj?.choices?.[0];
    const a = ch?.delta?.audio || ch?.message?.audio;
    if (a?.data) parts.push(a.data);
    if (a?.format) fmt = a.format;
    if (a?.transcript) transcript += a.transcript;
    if (typeof obj?.usage?.cost === 'number') cost = obj.usage.cost;
  };
  if (!(res.headers.get('content-type') || '').includes('event-stream')) {
    take(await res.json());
  } else {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        take(obj);
      }
    }
  }
  // chunks may be split anywhere (not 4-aligned) or padded one by one: decode at 4-char boundaries
  const out = [];
  let acc = '';
  for (const p of parts) {
    acc += String(p).replace(/\s/g, '');
    if (acc.length % 4 === 0) {
      out.push(Buffer.from(acc, 'base64'));
      acc = '';
    }
  }
  if (acc) out.push(Buffer.from(acc, 'base64'));
  const bytes = Buffer.concat(out);
  return { bytes, format: fmt, transcript: transcript.trim(), cost };
}
