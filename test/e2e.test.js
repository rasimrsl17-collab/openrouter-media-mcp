// End-to-end test: mock OpenRouter <- MCP server <- official MCP SDK client
// (the same transport type LibreChat uses for `type: streamable-http`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start, seen, startLitellm, customers, litellmSeen } from './mock-openrouter.js';

const MOCK_PORT = 4555;
const MCP_PORT = 3499;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ormcp-'));
const LL_PORT = 4556;
const mock = await start(MOCK_PORT);
const llMock = await startLitellm(LL_PORT);
// two paying users with plenty of credit, a free user, and a nearly empty one
customers.set('user-A', { spend: 1, max_budget: 100 });
customers.set('user-B', { spend: 0, max_budget: 100 });
customers.set('user-FREE', { spend: 0.0007, max_budget: 0.0012, models: ['gemma-3-4b-it'] });
customers.set('user-C', { spend: 0, max_budget: 0.25 });
customers.set('user-V', { spend: 0, max_budget: 10 });
customers.set('user-BLOCKED', { spend: 0, max_budget: 100, blocked: true });

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
  assert.deepEqual(tools, ['check_video_status', 'generate_image', 'generate_speech', 'generate_video', 'list_media_models']);
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
}
