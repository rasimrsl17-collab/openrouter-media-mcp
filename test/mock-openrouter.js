// Local mock of the OpenRouter media endpoints, returning the response shapes
// documented at openrouter.ai/docs. Used only for automated tests.
import express from 'express';
import sharp from 'sharp';

const app = express();
app.use(express.json({ limit: '5mb' }));
export const seen = [];

app.use((req, res, next) => {
  seen.push({ method: req.method, path: req.path, query: req.query, body: req.body });
  if (req.get('authorization') !== 'Bearer test-key') return res.status(401).json({ error: { message: 'bad key', code: 401 } });
  next();
});

const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#cc5500' } }).png().toBuffer();
// a large image (> 8 MB as PNG) to exercise the preview downscaler
const bigPng = await sharp({
  create: { width: 3000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } },
})
  .png({ compressionLevel: 0 })
  .toBuffer();

app.post('/images', (req, res) => {
  if (req.body.model === 'bad/model') return res.status(400).json({ error: { message: 'Unsupported aspect_ratio', code: 400 } });
  const buf = req.body.prompt.includes('BIG') ? bigPng : png;
  const n = req.body.n ?? 1;
  res.json({
    created: 1748372400,
    data: Array.from({ length: n }, () => ({ b64_json: buf.toString('base64'), media_type: 'image/png' })),
    usage: { prompt_tokens: 0, completion_tokens: 4175, total_tokens: 4175, cost: 0.04 },
  });
});

app.get('/images/models', (_req, res) =>
  res.json({
    data: [
      {
        id: 'google/gemini-3.1-flash-image',
        name: 'Gemini 3.1 Flash Image',
        supported_parameters: { resolution: { type: 'enum', values: ['512', '1K', '2K', '4K'] } },
      },
      { id: 'other/not-allowed', name: 'x', supported_parameters: {} },
    ],
  }),
);

const jobs = new Map();
app.post('/videos', (req, res) => {
  const id = `job-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(id, { polls: 0, body: req.body });
  res.status(202).json({ id, polling_url: `/api/v1/videos/${id}`, status: 'pending' });
});
app.get('/videos/models', (_req, res) =>
  res.json({
    data: [
      {
        id: 'google/veo-3.1-lite',
        supported_resolutions: ['720p', '1080p'],
        supported_aspect_ratios: ['16:9', '9:16'],
        supported_sizes: null,
        supported_durations: [8, 4, 6],
        supported_frame_images: ['first_frame', 'last_frame'],
        generate_audio: true,
        pricing_skus: {
          duration_seconds_without_audio_720p: '0.03',
          duration_seconds_with_audio_720p: '0.05',
          duration_seconds_without_audio: '0.05',
          duration_seconds_with_audio: '0.08',
        },
      },
      {
        id: 'bytedance/seedance-2.0-fast',
        supported_resolutions: ['480p', '720p'],
        supported_aspect_ratios: ['16:9', '9:16', '1:1'],
        supported_durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        supported_frame_images: ['first_frame'],
        generate_audio: true,
      },
    ],
  }),
);
app.get('/videos/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: { message: 'not found' } });
  j.polls++;
  const done = j.polls >= 3;
  res.json({
    id: req.params.id,
    generation_id: 'gen-1',
    polling_url: `/api/v1/videos/${req.params.id}`,
    status: done ? 'completed' : 'in_progress',
    unsigned_urls: done ? [`https://openrouter.ai/api/v1/videos/${req.params.id}/content?index=0`] : [],
    usage: done ? { cost: 0.4, is_byok: false } : undefined,
  });
});
app.get('/videos/:id/content', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.polls < 3) return res.status(404).json({ error: { message: 'not ready' } });
  res.type('video/mp4').send(Buffer.from('FAKE-MP4-BYTES-'.repeat(1000)));
});

app.post('/audio/speech', (req, res) => {
  if (req.body.response_format !== 'mp3') return res.status(400).json({ error: { message: 'pcm not supported' } });
  res.set('X-Generation-Id', 'gen-tts-1').type('audio/mpeg').send(Buffer.from('ID3FAKEMP3'.repeat(200)));
});
app.get('/models', (req, res) =>
  res.json({ data: [
      {
        id: 'microsoft/mai-voice-2.1',
        name: 'MAI Voice 2.1',
        supported_voices: ['en-US-Harper:MAI-Voice-2.1'],
        pricing: { prompt: '0.0000006', completion: '0' },
      },
    ] }),
);

export function start(port) {
  return new Promise((r) => {
    const s = app.listen(port, () => r(s));
  });
}

// ---- Mock of LiteLLM's GET /customer/info (shapes taken from a real LiteLLM answer) ----
export const customers = new Map(); // id -> { spend, max_budget, blocked }
export const litellmSeen = [];
const ll = express();
ll.get('/customer/info', (req, res) => {
  litellmSeen.push({ auth: req.get('authorization'), id: req.query.end_user_id });
  if (req.get('authorization') !== 'Bearer cust-key') return res.status(401).json({ error: { message: 'no' } });
  const id = req.query.end_user_id;
  if (id === 'user-DOWN') return res.status(500).json({ error: 'boom' });
  const c = customers.get(id);
  if (!c) return res.status(400).json({ error: { message: `End User Id=${id} doesn't exist in db` } });
  res.json({
    user_id: id,
    blocked: c.blocked ?? false,
    spend: c.spend,
    models: c.models ?? [],
    litellm_budget_table: { max_budget: c.max_budget },
  });
});
export function startLitellm(port) {
  return new Promise((r) => {
    const s = ll.listen(port, () => r(s));
  });
}
