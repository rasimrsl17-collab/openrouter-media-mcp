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
        supported_durations: [4, 6, 8],
        supported_frame_images: ['first_frame', 'last_frame'],
        generate_audio: true,
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
// Speech-to-text: fake words every 0.5 s, enough to cover any audio up to the decoded byte length.
export const sttSeen = [];
app.post('/audio/transcriptions', (req, res) => {
  const b = req.body;
  sttSeen.push({ model: b.model, format: b.input_audio?.format, bytes: Buffer.from(b.input_audio?.data || '', 'base64').length,
    granularities: b.timestamp_granularities, language: b.language });
  if (!b.input_audio?.data) return res.status(400).json({ error: { message: 'input_audio required' } });
  const vocab = ['This', 'is', 'the', 'best', 'part,', 'listen', 'closely.', 'Then', 'we', 'win!'];
  const words = [];
  for (let t = 0.2, i = 0; t < 40; t += 0.5, i++) words.push({ word: vocab[i % vocab.length], start: +t.toFixed(2), end: +(t + 0.4).toFixed(2) });
  const segments = [];
  for (let i = 0; i < words.length; i += 10) {
    const g = words.slice(i, i + 10);
    segments.push({ start: g[0].start, end: g[g.length - 1].end, text: g.map((w) => w.word).join(' ') });
  }
  res.json({ text: words.map((w) => w.word).join(' '), language: b.language || 'english', duration: 40, words, segments, usage: { cost: 0.001, seconds: 40 } });
});
app.get('/models', (req, res) =>
  res.json({ data: [{ id: 'microsoft/mai-voice-2.1', name: 'MAI Voice 2.1', supported_voices: ['en-US-Harper:MAI-Voice-2.1'] }] }),
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

// ---- Mock of Post for Me's API (shapes read from github.com/DayMoonDevelopment/post-for-me, api/src) ----
export const pfmSeen = [];
export const pfm = { accounts: [], posts: [], results: [] };
const pf = express();
pf.use(express.json());
pf.use((req, res, next) => {
  pfmSeen.push({ method: req.method, path: req.path, query: req.query, body: req.body });
  if (req.get('authorization') !== 'Bearer pfm-key') return res.status(401).json({ message: 'Unauthorized' });
  next();
});
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
pf.post('/social-accounts/auth-url', (req, res) =>
  res.json({ url: `https://auth.example/${req.body.platform}?ext=${req.body.external_id}`, platform: req.body.platform }),
);
pf.get('/social-accounts', (req, res) => {
  const ext = arr(req.query.external_id);
  const data = pfm.accounts.filter((a) => !ext.length || ext.includes(a.external_id));
  res.json({ data: data.map((a) => ({ ...a, access_token: 'SECRET-TOKEN' })), meta: { total: data.length, offset: 0, limit: 100, next: null } });
});
pf.post('/social-posts', (req, res) => {
  const b = req.body;
  if (b.caption.includes('INVALID')) return res.status(400).json({ message: 'Invalid Request', errors: ['TikTok: video is too long'] });
  const accounts = b.social_accounts.map((id) => pfm.accounts.find((a) => a.id === id)).filter(Boolean);
  const post = { id: `sp_${pfm.posts.length + 1}`, caption: b.caption, status: b.isDraft ? 'draft' : b.scheduled_at ? 'scheduled' : 'processing', scheduled_at: b.scheduled_at ?? null, social_accounts: accounts, body: b };
  pfm.posts.push(post);
  if (post.status === 'processing') {
    accounts.forEach((a, i) =>
      pfm.results.push(
        i === 0
          ? { id: `r${pfm.results.length}`, post_id: post.id, social_account_id: a.id, success: true, error: null, platform_data: { id: 'x1', url: `https://${a.platform}.example/v/1` } }
          : { id: `r${pfm.results.length}`, post_id: post.id, social_account_id: a.id, success: false, error: 'Video must be under 60 seconds', platform_data: null },
      ),
    );
  }
  const { body, ...out } = post;
  res.status(201).json(out);
});
pf.get('/social-posts/:id', (req, res) => {
  const p = pfm.posts.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ message: 'Not found' });
  const { body, ...out } = p;
  res.json(out);
});
pf.get('/social-post-results', (req, res) => {
  const ids = arr(req.query.post_id);
  res.json({ data: pfm.results.filter((r) => ids.includes(r.post_id)), meta: {} });
});
export function startPostForMe(port) {
  return new Promise((r) => {
    const s = pf.listen(port, () => r(s));
  });
}
