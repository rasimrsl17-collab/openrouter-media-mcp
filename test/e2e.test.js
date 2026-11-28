// End-to-end test: mock OpenRouter <- MCP server <- official MCP SDK client
// (the same transport type LibreChat uses for `type: streamable-http`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execFileSync } from 'node:child_process';
import { start, seen, startLitellm, customers, litellmSeen, startZernio, zernio, zernioSeen, sttSeen } from './mock-openrouter.js';

const MOCK_PORT = 4555;
const MCP_PORT = 3499;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ormcp-'));
const LL_PORT = 4556;
const mock = await start(MOCK_PORT);
const llMock = await startLitellm(LL_PORT);
const ZN_PORT = 4557;
const znMock = await startZernio(ZN_PORT);
// two paying users with plenty of credit, a free user, and a nearly empty one
customers.set('user-A', { spend: 1, max_budget: 100 });
customers.set('user-B', { spend: 0, max_budget: 100 });
customers.set('user-FREE', { spend: 0.0007, max_budget: 0.0012, models: ['gemma-3-4b-it'] });
customers.set('user-C', { spend: 0, max_budget: 0.25 });
customers.set('user-V', { spend: 0, max_budget: 10 });
customers.set('user-BLOCKED', { spend: 0, max_budget: 100, blocked: true });

fs.mkdirSync(path.join(tmp, 'music'), { recursive: true });
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:a', 'libmp3lame', path.join(tmp, 'music', 'calm-1.mp3')]);
const proc = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    PORT: String(MCP_PORT),
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    MCP_SHARED_SECRET: 'sekret',
    ALLOW_NO_AUTH: 'true', // only relaxes the https check for this local test; the secret is still enforced
    PUBLIC_BASE_URL: `http://127.0.0.1:${MCP_PORT}`,
    MEDIA_DIR: path.join(tmp, 'media'),
    STATE_DIR: path.join(tmp, 'state'),
    LIMIT_IMAGES_PER_DAY: '4',
    LIMIT_VIDEOS_PER_DAY: '2',
    VIDEO_POLL_SECONDS: '1',
    LITELLM_URL: `http://127.0.0.1:${LL_PORT}`,
    LITELLM_CUSTOMER_KEY: 'cust-key',
    COST_MARKUP: '1.5',
    ESTIMATE_IMAGE_USD: '0.08',
    ESTIMATE_VIDEO_USD_PER_SECOND: '0.08',
    ZERNIO_API_KEY: 'zn-key',
    ZERNIO_BASE_URL: `http://127.0.0.1:${ZN_PORT}`,
    SOCIAL_REDIRECT_URL: 'https://velorafy.example/back',
    SOCIAL_POST_FEE_USD: '0.02',
    LIMIT_SHORTS_PER_DAY: '4',
    MAX_SHORT_SECONDS: '30',
    MUSIC_DIR: path.join(tmp, 'music'),
    ALLOW_PRIVATE_SOURCE_URLS: 'true', // the test serves the long video from 127.0.0.1
    LIMIT_SOURCE_MINUTES_PER_DAY: '1',
    LIMIT_CLIPS_PER_DAY: '3',
    MAX_CLIPS_PER_CALL: '2',
    SOURCE_WAIT_SECONDS: '60',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
proc.stdout.on('data', (d) => (logs += d));
proc.stderr.on('data', (d) => (logs += d));
for (let i = 0; i < 50 && !logs.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
assert.ok(logs.includes('listening'), 'server did not start:\n' + logs);

async function connect(headers) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

let passed = 0;
const ok = (name) => {
  passed++;
  console.log('  ✓', name);
};

try {
  // 1. auth
  await assert.rejects(connect({ 'x-api-key': 'wrong' }), 'wrong secret must be rejected');
  ok('wrong X-API-Key is rejected');

  const client = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-A' });
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    'assemble_short', 'check_video_status', 'cut_clips', 'generate_image', 'generate_speech', 'generate_video', 'get_video_transcript', 'list_media_models',
    'social_connect_account', 'social_list_accounts', 'social_publish', 'transcribe_video',
  ]);
  ok('tools listed: ' + tools.join(', '));

  // 2. image
  let r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'a red fox', aspect_ratio: '1:1' } });
  assert.ok(!r.isError, JSON.stringify(r));
  const img = r.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.ok(Buffer.from(img.data, 'base64').subarray(1, 4).toString() === 'PNG', 'image data is a real PNG');
  const imgReq = seen.findLast((s) => s.path === '/images');
  assert.equal(imgReq.body.model, 'google/gemini-3.1-flash-image');
  assert.equal(imgReq.body.response_format, 'b64_json');
  assert.equal(imgReq.body.aspect_ratio, '1:1');
  const link = r.content[0].text.match(/http:\/\/\S+\/media\/\S+\.png/)[0];
  const dl = await fetch(link);
  assert.equal(dl.status, 200);
  ok('generate_image -> base64 PNG content + working full-size link');

  // 3. big image gets downscaled under the 8 MB preview cap
  r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'BIG noise' } });
  const big = r.content.find((c) => c.type === 'image');
  assert.equal(big.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(big.data, 'base64').length <= 8 * 1024 * 1024);
  ok(`oversized image converted to JPEG preview (${(Buffer.from(big.data, 'base64').length / 1e6).toFixed(2)} MB)`);

  // 4. disallowed model + OpenRouter error passthrough
  r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'x', model: 'bad/model' } });
  assert.ok(r.isError && /not allowed/.test(r.content[0].text));
  ok('non-allowlisted model is refused before calling OpenRouter');

  // 5. quota: limit 4, used 2 -> n=2 is capped to MAX_IMAGES_PER_CALL=2 -> reaches 4, next call fails
  r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'two', n: 5 } });
  assert.equal(r.content.filter((c) => c.type === 'image').length, 2);
  r = await client.callTool({ name: 'generate_image', arguments: { prompt: 'over' } });
  assert.ok(r.isError && /Daily image limit/.test(r.content[0].text), JSON.stringify(r));
  ok('n capped at 2 per call; daily image quota enforced');

  // other user has own quota
  const clientB = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-B' });
  r = await clientB.callTool({ name: 'generate_image', arguments: { prompt: 'b' } });
  assert.ok(!r.isError);
  ok('quota is per user (X-User-ID)');

  // 6. video: validation from /videos/models caps
  r = await client.callTool({ name: 'generate_video', arguments: { prompt: 'p', duration: 7 } });
  assert.ok(r.isError && /supports durations 4, 6, 8/.test(r.content[0].text), JSON.stringify(r));
  r = await client.callTool({ name: 'generate_video', arguments: { prompt: 'p', duration: 30 } });
  assert.ok(r.isError && /limit of 8s/.test(r.content[0].text));
  r = await client.callTool({ name: 'generate_video', arguments: { prompt: 'p', resolution: '1080p' } });
  assert.ok(r.isError && /not allowed/.test(r.content[0].text));
  ok('video duration/resolution validated against model caps and server caps');

  // 7. video happy path: polls until completed, downloads, returns ui:// html player
  r = await client.callTool({ name: 'generate_video', arguments: { prompt: 'a cat surfing', aspect_ratio: '9:16' } });
  assert.ok(!r.isError, JSON.stringify(r));
  const vReq = seen.findLast((s) => s.path === '/videos' && s.method === 'POST');
  assert.deepEqual(
    { model: vReq.body.model, resolution: vReq.body.resolution, duration: vReq.body.duration, ar: vReq.body.aspect_ratio },
    { model: 'google/veo-3.1-lite', resolution: '720p', duration: 8, ar: '9:16' },
  );
  const res = r.content.find((c) => c.type === 'resource');
  assert.ok(res.resource.uri.startsWith('ui://openrouter-media/video/'));
  assert.equal(res.resource.mimeType, 'text/html');
  const vUrl = res.resource.text.match(/src="([^"]+)"/)[1];
  const vResp = await fetch(vUrl, { headers: { Range: 'bytes=0-9' } });
  assert.equal(vResp.status, 206, 'range requests supported for seeking');
  assert.equal(vResp.headers.get('content-type'), 'video/mp4');
  assert.ok(seen.some((s) => s.path.endsWith('/content') && s.query.index === '0'));
  const jobId = r.content[0].text.match(/job (job-\w+)/)[1];
  ok('generate_video -> polled to completed, downloaded, served with Range, ui:// player returned');

  // 8. check_video_status ownership + cached result
  r = await clientB.callTool({ name: 'check_video_status', arguments: { job_id: jobId } });
  assert.ok(r.isError && /Unknown job_id/.test(r.content[0].text));
  r = await client.callTool({ name: 'check_video_status', arguments: { job_id: jobId } });
  assert.ok(!r.isError && r.content.some((c) => c.type === 'resource'));
  ok('check_video_status: other users cannot read the job; owner gets the stored video');

  // 9. speech
  r = await client.callTool({ name: 'generate_speech', arguments: { text: 'Salam dünya' } });
  assert.ok(!r.isError, JSON.stringify(r));
  const sReq = seen.findLast((s) => s.path === '/audio/speech');
  assert.deepEqual(
    { model: sReq.body.model, voice: sReq.body.voice, fmt: sReq.body.response_format, input: sReq.body.input },
    { model: 'microsoft/mai-voice-2.1', voice: 'en-US-Harper:MAI-Voice-2.1', fmt: 'mp3', input: 'Salam dünya' },
  );
  const aRes = r.content.find((c) => c.type === 'resource');
  assert.ok(aRes.resource.text.includes('<audio'));
  assert.ok(!r.content.some((c) => c.type === 'audio'), 'no raw audio content (LibreChat would dump it as text)');
  ok('generate_speech -> mp3 requested, <audio> player resource, no raw audio blob');

  // 10. discovery
  r = await client.callTool({ name: 'list_media_models', arguments: { kind: 'image' } });
  const rows = JSON.parse(r.content[0].text);
  assert.deepEqual(rows.map((x) => x.id), ['google/gemini-3.1-flash-image']);
  r = await client.callTool({ name: 'list_media_models', arguments: { kind: 'speech' } });
  assert.ok(r.content[0].text.includes('en-US-Harper:MAI-Voice-2.1'));
  ok('list_media_models filters to the allowlist and shows voices');

  // 11. usage log written
  const usage = fs.readFileSync(path.join(tmp, 'state', 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(usage.some((u) => u.kind === 'video' && u.cost === 0.4));
  assert.ok(usage.some((u) => u.kind === 'image' && u.cost === 0.04));
  ok(`usage.jsonl has ${usage.length} entries with OpenRouter costs`);

  // 12. credit check (LiteLLM customer budget) ----------------------------------------
  const freeC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-FREE' });
  const before = seen.filter((x) => x.path === '/images').length;
  r = await freeC.callTool({ name: 'generate_image', arguments: { prompt: 'free user' } });
  assert.ok(r.isError && /Not enough credit/.test(r.content[0].text), JSON.stringify(r));
  assert.equal(seen.filter((x) => x.path === '/images').length, before, 'OpenRouter must not be called for a free user');
  r = await freeC.callTool({ name: 'generate_video', arguments: { prompt: 'v' } });
  assert.ok(r.isError && /Not enough credit/.test(r.content[0].text));
  r = await freeC.callTool({ name: 'generate_speech', arguments: { text: 'salam' } });
  assert.ok(r.isError && /Not enough credit/.test(r.content[0].text));
  assert.ok(litellmSeen.some((x) => x.auth === 'Bearer cust-key' && x.id === 'user-FREE'));
  ok('free plan (0.0012 limit, model list restricted): image, video and speech are refused before OpenRouter is called');

  const unknownC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-NEW' });
  r = await unknownC.callTool({ name: 'generate_image', arguments: { prompt: 'x' } });
  assert.ok(r.isError && /Not enough credit/.test(r.content[0].text));
  const blockedC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-BLOCKED' });
  r = await blockedC.callTool({ name: 'generate_image', arguments: { prompt: 'x' } });
  assert.ok(r.isError && /Not enough credit/.test(r.content[0].text));
  ok('user unknown to LiteLLM and blocked user are refused');

  const downC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-DOWN' });
  const calls = seen.filter((x) => x.path === '/images').length;
  r = await downC.callTool({ name: 'generate_image', arguments: { prompt: 'x' } });
  assert.ok(r.isError && /temporarily unavailable/.test(r.content[0].text));
  assert.equal(seen.filter((x) => x.path === '/images').length, calls);
  ok('LiteLLM failure -> fails closed, nothing generated');

  // user-C: max 0.25, markup 1.5. Image costs 0.04 -> charged 0.06 each. Needs est 0.08*1.5 = 0.12.
  const cC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-C' });
  let generated = 0;
  for (let i = 0; i < 20; i++) {
    r = await cC.callTool({ name: 'generate_image', arguments: { prompt: 'c' + i } });
    if (r.isError) break;
    generated++;
  }
  assert.ok(r.isError && /Not enough credit/.test(r.content[0].text));
  // remaining after n images = 0.25 - 0.06n; the next one needs 0.12 -> 0.07 < 0.12 after n = 3
  assert.equal(generated, 3, `expected 3 images, got ${generated}`);
  ok('credit is deducted per image (cost x 1.5) until the estimate no longer fits (3 images)');

  // parallel calls cannot overspend: user-P has room for exactly one 0.12 estimate
  customers.set('user-P', { spend: 0, max_budget: 0.15 });
  const pC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-P' });
  const pC2 = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-P' });
  const both = await Promise.all([
    pC.callTool({ name: 'generate_image', arguments: { prompt: 'p1' } }),
    pC2.callTool({ name: 'generate_image', arguments: { prompt: 'p2' } }),
  ]);
  assert.equal(both.filter((x) => !x.isError).length, 1, 'only one of two parallel calls may pass');
  ok('two parallel calls cannot both spend the same last credit');

  // video: provisional charge corrected to the real cost (0.4 x 1.5 = 0.6)
  const vC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-V' });
  r = await vC.callTool({ name: 'generate_video', arguments: { prompt: 'a bird' } });
  assert.ok(!r.isError, JSON.stringify(r));
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8'));
  assert.ok(Math.abs(st.media['user-V'] - 0.6) < 1e-9, 'video charged at real cost x markup: ' + st.media['user-V']);
  ok('video: provisional charge replaced by the real cost x markup (0.60)');

  // speech: 11 chars * 0.03/1000 * 1.5
  r = await vC.callTool({ name: 'generate_speech', arguments: { text: 'Salam dünya' } });
  assert.ok(!r.isError);
  const st2 = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8'));
  assert.ok(Math.abs(st2.media['user-V'] - (0.6 + (11 / 1000) * 0.03 * 1.5)) < 1e-9);
  ok('speech charged by estimate x markup');

  // raising max_budget (a purchase) immediately restores access
  customers.set('user-FREE', { spend: 0.0007, max_budget: 5, models: [] });
  r = await freeC.callTool({ name: 'generate_image', arguments: { prompt: 'after purchase' } });
  assert.ok(!r.isError, JSON.stringify(r));
  ok('after billing raises max_budget the same user can generate');


  // ================= Creator Studio =================
  const sC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-S' });
  customers.set('user-S', { spend: 0, max_budget: 10 });
  const sceneUrls = [];
  for (let i = 0; i < 3; i++) {
    r = await sC.callTool({ name: 'generate_image', arguments: { prompt: 'scene ' + i, aspect_ratio: '9:16' } });
    assert.ok(!r.isError, JSON.stringify(r));
    sceneUrls.push(r.content[0].text.match(/http:\/\/\S+\/media\/[a-f0-9]{32}\.png/)[0]);
  }
  // a REAL 5.5 s mp3 voiceover placed in the media dir (the mock TTS returns fake bytes)
  const voiceName = 'a'.repeat(32) + '.mp3';
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5.5', '-c:a', 'libmp3lame', path.join(tmp, 'media', voiceName)]);
  const voiceUrl = `http://127.0.0.1:${MCP_PORT}/media/${voiceName}`;

  r = await sC.callTool({
    name: 'assemble_short',
    arguments: {
      scenes: [
        { media_url: sceneUrls[0], seconds: 2, caption: 'Kosmosda 3 sirr 🚀' },
        { media_url: sceneUrls[1], seconds: 1.5, caption: 'Ərəb, Türk, English — any language: ə ğ ş ç' },
        { media_url: sceneUrls[2], seconds: 1 },
      ],
      voiceover_url: voiceUrl,
    },
  });
  assert.ok(!r.isError, JSON.stringify(r));
  const shortUrl = r.content[0].text.match(/http:\/\/\S+\/media\/[a-f0-9]{32}\.mp4/)[0];
  assert.ok(r.content.some((c) => c.type === 'resource' && c.resource.text.includes('<video')));
  const shortFile = path.join(tmp, 'media', shortUrl.split('/').pop());
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', shortFile]).toString(),
  );
  const vs = probe.streams.find((x) => x.codec_type === 'video');
  assert.deepEqual([vs.width, vs.height], [1080, 1920]);
  assert.ok(probe.streams.some((x) => x.codec_type === 'audio'), 'has audio track');
  const dur = Number(probe.format.duration);
  assert.ok(dur >= 5.5 && dur < 6.3, 'last scene stretched to cover the 5.5 s voiceover, got ' + dur);
  const stt = sttSeen.at(-1);
  assert.equal(stt.model, 'openai/whisper-large-v3');
  assert.deepEqual(stt.granularities, ['word', 'segment']);
  assert.ok(stt.bytes > 1000 && stt.format === 'mp3');
  ok(`assemble_short -> 1080x1920 H.264+AAC, ${dur.toFixed(2)}s (scenes 4.5s, stretched to voiceover), word captions from STT`);

  const sttBefore = sttSeen.length;
  r = await sC.callTool({
    name: 'assemble_short',
    arguments: { scenes: [{ media_url: sceneUrls[0], seconds: 3, caption: 'hi' }], voiceover_url: voiceUrl, caption_style: 'scene', music: 'calm', title: 'Hook', motion: false },
  });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(sttSeen.length, sttBefore, 'scene captions do not call STT');
  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: [{ media_url: sceneUrls[0], seconds: 2 }], music: 'disco' } });
  assert.ok(r.isError && /calm-1/.test(r.content[0].text), 'unknown music lists available tracks');
  ok('assemble_short: music by mood prefix (ducked), title, static mode; unknown track rejected with the list');

  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: [{ media_url: sceneUrls[0], seconds: 2 }] } });
  assert.ok(!r.isError, 'works without voiceover (silent track)');
  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: [{ media_url: 'https://evil.example/x.png', seconds: 2 }] } });
  assert.ok(r.isError && /created by this server/.test(r.content[0].text));
  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: [{ media_url: sceneUrls[0].replace(/[a-f0-9]{32}/, '../../etc/passwd'), seconds: 2 }] } });
  assert.ok(r.isError);
  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: [{ media_url: sceneUrls[0], seconds: 2 }], voiceover_url: sceneUrls[1] } });
  assert.ok(r.isError && /audio link/.test(r.content[0].text));
  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: Array(2).fill({ media_url: sceneUrls[0], seconds: 20 }) } });
  assert.ok(r.isError && /at most 30s/.test(r.content[0].text), JSON.stringify(r));
  ok('assemble_short rejects foreign URLs, path tricks, non-audio voiceover and over-length videos');
  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: [{ media_url: sceneUrls[0], seconds: 1 }] } });
  assert.ok(!r.isError);
  r = await sC.callTool({ name: 'assemble_short', arguments: { scenes: [{ media_url: sceneUrls[0], seconds: 1 }] } });
  assert.ok(r.isError && /Daily short video limit/.test(r.content[0].text), JSON.stringify(r));
  ok('daily short-video limit enforced (4)');


  // ---- long video -> clips ----
  const srcName = 'b'.repeat(32) + '.mp4';
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=40', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', path.join(tmp, 'media', srcName)]);
  const srcUrl = `http://127.0.0.1:${MCP_PORT}/media/${srcName}`;
  r = await sC.callTool({ name: 'transcribe_video', arguments: { url: 'https://www.youtube.com/watch?v=abc' } });
  assert.ok(r.isError && /cannot be downloaded/.test(r.content[0].text));
  const mediaBefore = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8')).media['user-S'];
  r = await sC.callTool({ name: 'transcribe_video', arguments: { url: srcUrl, language: 'en' } });
  assert.ok(!r.isError, JSON.stringify(r));
  const sourceId = r.content[0].text.match(/source_id: ([a-f0-9]{24})/)[1];
  assert.ok(/\[0:00-0:0\d\] This is the best part/.test(r.content[0].text), r.content[0].text.slice(0, 400));
  const mediaAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8')).media['user-S'];
  assert.ok(Math.abs(mediaAfter - mediaBefore - 0.01 * 1 * 1.5) < 1e-9, `charged 1 min x $0.01 x 1.5, got ${mediaAfter - mediaBefore}`);
  ok('transcribe_video: downloads, transcribes with timestamps, charges per minute with markup; refuses YouTube page links');

  const otherC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-B' });
  r = await otherC.callTool({ name: 'cut_clips', arguments: { source_id: sourceId, clips: [{ start: 0, end: 10 }] } });
  assert.ok(r.isError && /Unknown source_id/.test(r.content[0].text));
  r = await sC.callTool({ name: 'cut_clips', arguments: { source_id: sourceId, clips: [{ start: 0, end: 3 }] } });
  assert.ok(r.isError && /5-30s/.test(r.content[0].text));
  ok("cut_clips: other users cannot use someone else's source; length limits enforced");

  r = await sC.callTool({
    name: 'cut_clips',
    arguments: { source_id: sourceId, framing: 'fit', clips: [{ start: 2, end: 9, title: 'Best part' }, { start: 20, end: 27.5 }] },
  });
  assert.ok(!r.isError, JSON.stringify(r));
  const clipUrls = r.content[0].text.match(/http:\/\/\S+\/media\/[a-f0-9]{32}\.mp4/g);
  assert.equal(clipUrls.length, 2);
  for (const [i, u] of clipUrls.entries()) {
    const pr = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json',
      path.join(tmp, 'media', u.split('/').pop())]).toString());
    const v = pr.streams.find((x) => x.codec_type === 'video');
    assert.deepEqual([v.width, v.height], [1080, 1920]);
    const d = Number(pr.format.duration);
    assert.ok(Math.abs(d - [7, 7.5][i]) < 0.25, 'clip length ' + d);
  }
  r = await sC.callTool({ name: 'cut_clips', arguments: { source_id: sourceId, clips: [{ start: 10, end: 16 }, { start: 30, end: 36 }] } });
  assert.ok(r.isError && /Daily clip limit/.test(r.content[0].text), JSON.stringify(r));
  r = await sC.callTool({ name: 'get_video_transcript', arguments: { source_id: sourceId } });
  assert.ok(!r.isError && r.content[0].text.includes(sourceId));
  r = await sC.callTool({ name: 'transcribe_video', arguments: { url: srcUrl } });
  assert.ok(r.isError && /video-minutes limit/.test(r.content[0].text), JSON.stringify(r));
  ok('cut_clips -> vertical 1080x1920 clips (fit framing, title, word captions); daily clip + minutes limits enforced');

  // ---- social publishing ----
  r = await sC.callTool({ name: 'social_connect_account', arguments: { platform: 'youtube' } });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.ok(r.content[0].text.includes('https://auth.example/youtube?p=prof_1'));
  const conn = zernioSeen.findLast((x) => x.path.startsWith('/connect/'));
  assert.equal(conn.query.redirect_url, 'https://velorafy.example/back');
  assert.equal(zernio.profiles[0].externalId, 'user-S');
  ok('social_connect_account creates one profile per user (externalId) and returns the OAuth link');

  // the user finishes OAuth: accounts appear in their profile; another user owns a different account
  zernio.accounts.push({ _id: 'acc_yt_S', platform: 'youtube', username: 'spacefacts', isActive: true, profileId: 'prof_1' });
  zernio.accounts.push({ _id: 'acc_tt_S', platform: 'tiktok', username: 'spacefacts', isActive: true, profileId: 'prof_1' });
  const oC = await connect({ 'x-api-key': 'sekret', 'x-user-id': 'user-O' });
  r = await oC.callTool({ name: 'social_list_accounts', arguments: {} });
  assert.ok(/No accounts connected/.test(r.content[0].text));
  zernio.accounts.push({ _id: 'acc_yt_O', platform: 'youtube', username: 'other', isActive: true, profileId: 'prof_2' });

  r = await sC.callTool({ name: 'social_list_accounts', arguments: {} });
  const accs = JSON.parse(r.content[0].text);
  assert.deepEqual(accs.map((a) => a.account_id).sort(), ['acc_tt_S', 'acc_yt_S']);
  const profileCalls = zernioSeen.filter((x) => x.method === 'POST' && x.path === '/profiles').length;
  assert.equal(profileCalls, 2, 'profile is created once per user and then cached');
  ok("social_list_accounts shows only the user's own accounts");

  r = await sC.callTool({
    name: 'social_publish',
    arguments: { media_urls: [shortUrl], caption: 'x', targets: [{ account_id: 'acc_yt_O' }], mode: 'now' },
  });
  assert.ok(r.isError && /not connected to this user/.test(r.content[0].text));
  r = await sC.callTool({
    name: 'social_publish',
    arguments: { media_urls: ['https://evil.example/a.mp4'], caption: 'x', targets: [{ account_id: 'acc_yt_S' }], mode: 'now' },
  });
  assert.ok(r.isError && /Only media created by this server/.test(r.content[0].text));
  assert.ok(!zernioSeen.some((x) => x.path === '/posts'), 'nothing was posted');
  ok("social_publish refuses another user's account and foreign media before calling Zernio");

  const spendBefore = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8')).media['user-S'];
  r = await sC.callTool({
    name: 'social_publish',
    arguments: {
      media_urls: [shortUrl],
      caption: '3 space secrets\n#space #shorts',
      targets: [{ account_id: 'acc_yt_S', youtube_title: '3 Space Secrets' }, { account_id: 'acc_tt_S' }],
      mode: 'now',
    },
  });
  assert.ok(!r.isError, JSON.stringify(r));
  const posted = zernioSeen.findLast((x) => x.path === '/posts');
  assert.equal(posted.body.publishNow, true);
  assert.equal(posted.body.profileId, 'prof_1');
  assert.deepEqual(posted.body.mediaItems, [{ url: shortUrl }]);
  assert.deepEqual(posted.body.platforms, [
    { platform: 'youtube', accountId: 'acc_yt_S', platformSpecificData: { title: '3 Space Secrets' } },
    { platform: 'tiktok', accountId: 'acc_tt_S' },
  ]);
  assert.ok(posted.idem && posted.idem.length >= 32, 'Idempotency-Key sent');
  const spendAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8')).media['user-S'];
  assert.ok(Math.abs(spendAfter - spendBefore - 0.02 * 2 * 1.5) < 1e-9, 'fee 0.02 x 2 accounts x markup 1.5');
  ok('social_publish now: correct Zernio body (platform from account, YouTube title, idempotency) + per-account fee charged');

  r = await sC.callTool({
    name: 'social_publish',
    arguments: { media_urls: [shortUrl], caption: 'later', targets: [{ account_id: 'acc_tt_S' }], mode: 'schedule' },
  });
  assert.ok(r.isError && /scheduled_for is required/.test(r.content[0].text));
  r = await sC.callTool({
    name: 'social_publish',
    arguments: { media_urls: [shortUrl], caption: 'later', targets: [{ account_id: 'acc_tt_S' }], mode: 'schedule', scheduled_for: '2026-12-01T18:00:00', timezone: 'America/New_York' },
  });
  assert.ok(!r.isError);
  const sched = zernioSeen.findLast((x) => x.path === '/posts').body;
  assert.deepEqual([sched.scheduledFor, sched.timezone, sched.publishNow], ['2026-12-01T18:00:00', 'America/New_York', undefined]);
  ok('social_publish schedule passes scheduledFor + timezone');

  const s1 = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8')).media['user-S'];
  r = await sC.callTool({
    name: 'social_publish',
    arguments: { media_urls: [shortUrl], caption: 'FAILALL', targets: [{ account_id: 'acc_tt_S' }], mode: 'now' },
  });
  assert.ok(r.isError && /FAILED/.test(r.content[0].text) && /too long/.test(r.content[0].text));
  const s2 = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'state.json'), 'utf8')).media['user-S'];
  assert.equal(s2, s1, 'a fully failed post is not charged');
  ok('HTTP 207 total failure is reported as an error and not charged');

  const anonC = await connect({ 'x-api-key': 'sekret' });
  r = await anonC.callTool({ name: 'social_list_accounts', arguments: {} });
  assert.ok(r.isError && /signed-in user/.test(r.content[0].text));
  ok('social tools refuse requests without a user id');

  await client.close();
  await clientB.close();
  console.log(`\nALL ${passed} CHECKS PASSED`);
} catch (err) {
  console.error('\nFAILED:', err);
  console.error('--- server logs ---\n' + logs);
  process.exitCode = 1;
} finally {
  proc.kill();
  mock.close();
  llMock.close();
  znMock.close();
}
