// Price estimates from the OpenRouter catalog (used to hold credit before a call, and as the
// charge for speech, which OpenRouter does not report a cost for).

import * as or from './openrouter.js';
import { config } from './config.js';

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
};

// ---- video: pricing_skus from GET /videos/models --------------------------------
// Examples seen in the real catalog: veo-3.1-lite { duration_seconds_without_audio_720p: "0.03",
// duration_seconds_with_audio_720p: "0.05" }, heygen-video-1 { duration_seconds_480p: "0.02" },
// gemini-omni-1.2-flash { duration_seconds_with_audio_720p: "0.069504" }. Seedance bills per video
// token (no per-second SKU), so those fall back to ESTIMATE_VIDEO_USD_PER_SECOND.
export function videoEstimateUsd(caps, { resolution, duration, audio }) {
  const seconds = duration ?? config.maxVideoSeconds;
  const sku = caps?.pricing_skus;
  if (sku && typeof sku === 'object') {
    const primary = audio ? 'with' : 'without';
    const other = audio ? 'without' : 'with';
    const keys = [];
    for (const a of [primary, other]) {
      if (resolution) keys.push(`duration_seconds_${a}_audio_${resolution}`);
      keys.push(`duration_seconds_${a}_audio`);
    }
    if (resolution) keys.push(`duration_seconds_${resolution}`);
    keys.push('duration_seconds');
    for (const k of keys) {
      const price = num(sku[k]);
      if (price > 0) return { usd: price * seconds, source: `sku:${k}` };
    }
  }
  return { usd: config.estimateVideoUsdPerSecond * seconds, source: 'fallback' };
}

// ---- speech: pricing from GET /models?output_modalities=speech --------------------
let speechCache = { at: 0, byId: new Map() };

/** Catalog entry of a speech model (cached 1h). Returns undefined if the catalog is unreachable. */
export async function speechModel(id) {
  if (Date.now() - speechCache.at > 3600_000) {
    try {
      const all = await or.listSpeechModels();
      speechCache = { at: Date.now(), byId: new Map(all.map((x) => [x.id, x])) };
    } catch (err) {
      console.error('[pricing] speech catalog unavailable:', err?.message || err);
      return speechCache.byId.get(id);
    }
  }
  return speechCache.byId.get(id);
}

/** USD for `chars` characters. Character-priced models have pricing.prompt per character. */
export function ttsUsd(model, chars) {
  const per = num(model?.pricing?.prompt);
  const completion = num(model?.pricing?.completion ?? 0);
  if (per > 0 && !(completion > 0)) return { usd: per * chars, source: 'catalog' };
  // token-priced, free or unknown: use the configured estimate
  return { usd: (chars / 1000) * config.estimateTtsUsdPer1kChars, source: 'fallback' };
}

export function firstVoice(model) {
  const v = Array.isArray(model?.supported_voices) ? model.supported_voices[0] : undefined;
  return typeof v === 'string' ? v : v?.id || v?.name || undefined;
}
