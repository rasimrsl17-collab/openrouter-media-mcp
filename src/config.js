// All settings come from environment variables (see .env.example).

function list(name, fallback) {
  const raw = process.env[name] ?? fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return Math.trunc(n);
}

export const config = {
  port: int('PORT', 3400),
  openrouterKey: process.env.OPENROUTER_API_KEY || '',
  // Override only for local testing against a mock server.
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),

  // Shared secret LibreChat sends in the X-API-Key header (see librechat.yaml).
  sharedSecret: process.env.MCP_SHARED_SECRET || '',
  allowNoAuth: process.env.ALLOW_NO_AUTH === 'true',

  // Public HTTPS address where /media/* of this server is reachable from users' browsers.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  mediaDir: process.env.MEDIA_DIR || '/data/media',
  stateDir: process.env.STATE_DIR || '/data/state',
  mediaTtlDays: int('MEDIA_TTL_DAYS', 30),

  // Admin-fixed model allowlists. The first entry is the default.
  imageModels: list('ALLOWED_IMAGE_MODELS', 'google/gemini-3.1-flash-image,bytedance-seed/seedream-5-0-flash'),
  videoModels: list('ALLOWED_VIDEO_MODELS', 'google/veo-3.1-lite,bytedance/seedance-2.0-fast'),
  ttsModels: list('ALLOWED_TTS_MODELS', 'microsoft/mai-voice-2.1'),
  defaultTtsVoice: process.env.DEFAULT_TTS_VOICE || 'en-US-Harper:MAI-Voice-2.1',

  // Per-user daily limits (UTC day). 0 disables the tool.
  limitImagesPerDay: int('LIMIT_IMAGES_PER_DAY', 20),
  limitVideosPerDay: int('LIMIT_VIDEOS_PER_DAY', 2),
  limitTtsPerDay: int('LIMIT_TTS_PER_DAY', 30),

  // Cost caps.
  maxImagesPerCall: int('MAX_IMAGES_PER_CALL', 2),
  maxVideoSeconds: int('MAX_VIDEO_SECONDS', 8),
  allowedVideoResolutions: list('ALLOWED_VIDEO_RESOLUTIONS', '480p,720p'),
  maxTtsChars: int('MAX_TTS_CHARS', 3000),

  // Video polling inside one tool call. Keep below LibreChat's MCP `timeout`.
  videoMaxWaitSeconds: int('VIDEO_MAX_WAIT_SECONDS', 240),
  videoPollSeconds: int('VIDEO_POLL_SECONDS', 6),

  // LibreChat rejects MCP images above 10 MB (MCP_IMAGE_DATA_MAX_BYTES); stay safely below.
  previewMaxBytes: int('PREVIEW_MAX_BYTES', 8 * 1024 * 1024),
};

export function validateConfig() {
  const problems = [];
  if (!config.openrouterKey) problems.push('OPENROUTER_API_KEY is not set');
  if (!config.sharedSecret && !config.allowNoAuth) {
    problems.push('MCP_SHARED_SECRET is not set (set ALLOW_NO_AUTH=true only for local tests)');
  }
  if (!config.publicBaseUrl) {
    problems.push('PUBLIC_BASE_URL is not set (needed to show videos/audio in the browser)');
  } else if (!config.publicBaseUrl.startsWith('https://') && !config.allowNoAuth) {
    problems.push('PUBLIC_BASE_URL must be https:// (browsers block http media on an https site)');
  }
  if (!config.imageModels.length && !config.videoModels.length && !config.ttsModels.length) {
    problems.push('No models allowed at all');
  }
  return problems;
}
