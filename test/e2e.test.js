// End-to-end test: mock OpenRouter <- MCP server <- official MCP SDK client
// (the same transport type LibreChat uses for `type: streamable-http`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start, seen } from './mock-openrouter.js';

const MOCK_PORT = 4555;
const MCP_PORT = 3499;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ormcp-'));
const mock = await start(MOCK_PORT);

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
}
