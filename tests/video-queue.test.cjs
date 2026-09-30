// Real SQLite in an isolated directory; all provider requests use mocked fetch.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'video-queue-test-'));
const cwd = process.cwd();
process.chdir(sandbox);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (id, ...args) { return resolve.call(this, id.startsWith('@/') ? path.join(root, id.slice(2)) : id, ...args); };
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
process.env.AGNES_API_KEY = 'test-only';
const originalFetch = global.fetch;
const originalNow = Date.now;
let time = 1_800_000_000_000;
Date.now = () => time;
let requests = [];
let respond;
global.fetch = async (url, init) => { requests.push({ url, init }); return respond(url, init); };
const { getDb, updateNodeData } = require('../lib/db.ts');
const queue = require('../lib/video-queue.ts');
const db = getDb();
const body = { model: 'agnes-video-2.5-flash', prompt: 'test', seconds: '8' };
const response = (status, data, headers) => new Response(JSON.stringify(data), { status, headers });
function reset() {
  db.exec('DELETE FROM gen_tasks; DELETE FROM nodes;');
  queue.submissionInfo('init');
  db.exec('DELETE FROM video_submissions; UPDATE video_submit_gate SET next_at=0;');
  requests = [];
  respond = () => response(200, { id: 'remote-1' });
  time += 2_000_000;
}
function task(id) { return db.prepare('SELECT * FROM gen_tasks WHERE id=?').get(id); }
after(() => { db.close(); process.chdir(cwd); Date.now = originalNow; global.fetch = originalFetch; fs.rmSync(sandbox, { recursive: true, force: true }); });

test('duplicate enqueue and concurrent workers create exactly one remote task', async () => {
  reset();
  const a = queue.enqueueVideo('p', 'n', body);
  assert.equal(queue.enqueueVideo('p', 'n', body).id, a.id);
  await Promise.all([queue.submitQueuedVideo(), queue.submitQueuedVideo()]);
  assert.equal(requests.length, 1);
  assert.equal(task(a.id).agnes_task_id, 'remote-1');
  assert.equal(queue.enqueueVideo('p', 'n', body).id, a.id);
  queue.enqueueVideo('p', 'next', body);
  time += 100_000;
  await queue.submitQueuedVideo();
  assert.equal(requests.length, 1, 'pending remote task blocks new submissions');
});

test('queue full persists increasing backoff, reload does not bypass it', async () => {
  reset(); respond = () => response(503, { code: 'video_queue_full' });
  const a = queue.enqueueVideo('p', 'n', body);
  await queue.submitQueuedVideo();
  assert.equal(task(a.id).status, 'queued');
  assert.equal(queue.submissionInfo(a.id).next_at, time + 65_000);
  delete require.cache[require.resolve('../lib/video-queue.ts')];
  await require('../lib/video-queue.ts').submitQueuedVideo();
  assert.equal(requests.length, 1);
  time += 65_000;
  await queue.submitQueuedVideo();
  assert.equal(queue.submissionInfo(a.id).next_at, time + 130_000);
  time += 130_000; respond = () => response(200, { id: 'recovered' });
  await queue.submitQueuedVideo();
  assert.equal(task(a.id).agnes_task_id, 'recovered');
});

test('429 respects Retry-After and gates all queued nodes', async () => {
  reset(); respond = () => response(429, { error: { code: 'rate_limit_exceeded' } }, { 'Retry-After': '180' });
  const a = queue.enqueueVideo('p', 'n', body);
  queue.enqueueVideo('p', 'n2', body);
  await queue.submitQueuedVideo();
  assert.equal(queue.submissionInfo(a.id).next_at, time + 180_000);
  time += 70_000; await queue.submitQueuedVideo();
  assert.equal(requests.length, 1);
});

test('persistent queue full stops after six attempts', async () => {
  reset(); respond = () => response(503, { code: 'video_queue_full' });
  const a = queue.enqueueVideo('p', 'n', body);
  for (let i = 0; i < 6; i++) { await queue.submitQueuedVideo(); time += 310_000; }
  assert.equal(requests.length, 6);
  assert.equal(task(a.id).status, 'failed');
  assert.match(task(a.id).error, /队列已满.*6/);
  await queue.submitQueuedVideo(); assert.equal(requests.length, 6);
});

test('uncertain network/504 and invalid requests are never auto-resubmitted', async () => {
  for (const status of [0, 400, 401, 504]) {
    reset(); respond = () => { if (!status) throw new Error('connection lost'); return response(status, {}); };
    const a = queue.enqueueVideo('p', 'n', body);
    await queue.submitQueuedVideo(); time += 1_000_000; await queue.submitQueuedVideo();
    assert.equal(requests.length, 1);
    assert.equal(task(a.id).status, 'failed');
  }
});

test('crash during POST becomes unknown outcome, not another POST', async () => {
  reset(); const a = queue.enqueueVideo('p', 'n', body);
  db.prepare('UPDATE video_submissions SET submitting_at=? WHERE task_id=?').run(time - 301_000, a.id);
  await queue.submitQueuedVideo();
  assert.equal(requests.length, 0); assert.equal(task(a.id).status, 'failed');
  assert.match(task(a.id).error, /结果未知/);
});

test('poller backs off on 429 then completes the same remote task', async () => {
  reset(); const a = queue.enqueueVideo('p', 'n', body); await queue.submitQueuedVideo();
  let tick;
  const interval = global.setInterval;
  global.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  let polls = 0;
  respond = (url) => {
    if (String(url).includes('/agnesapi')) { polls++; return polls === 1 ? response(429, {}) : response(200, { status: 'completed', url: 'https://mock.local/video' }); }
    return new Response('video bytes', { headers: { 'content-type': 'video/mp4' } });
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    require('../lib/poll.ts').startVideoPoller(); await flush();
    assert.equal(polls, 1);
    time += 30_000; tick(); await flush(); assert.equal(polls, 1);
    time += 36_000; tick(); await flush(); await flush();
    assert.equal(polls, 2);
    assert.equal(task(a.id).status, 'completed');
    assert.equal(task(a.id).agnes_task_id, 'remote-1');
    assert.ok(task(a.id).media_id);
  } finally { global.setInterval = interval; delete global.videoPollState; }
});

test('video wait beyond 15 minutes queries original task; failed video is not resubmitted', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'lib/agent-orchestrator.ts'), 'utf8') + '\nexport { waitForNode, generateAndAwait };';
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  let clock = 0, creates = 0, lookups = 0;
  const node = { id: 'node', data: { kind: 'video', status: 'generating' } };
  const store = { projectId: 'p', nodes: [node], updateNodeData(id, patch) { Object.assign(node.data, patch); }, async triggerGeneration() { creates++; node.data.status = 'failed'; } };
  vm.runInNewContext(code, {
    exports: mod.exports, module: mod, console, AbortSignal,
    Date: { now: () => clock },
    setTimeout: fn => { clock += 1000; fn(); },
    fetch: async url => { lookups++; assert.match(url, /nodeId=node/); return { ok: true, json: async () => ({ recent: [{ node_id: 'node', status: 'completed', media_id: 'saved-video' }] }) }; },
    require: id => id === './store' ? { useCanvasStore: { getState: () => store } } : {},
  });
  assert.equal(await mod.exports.waitForNode('node', 900_000), true);
  assert.ok(clock >= 900_000);
  assert.equal(creates, 0); assert.equal(lookups, 1); assert.equal(node.data.mediaId, 'saved-video');
  assert.equal(await mod.exports.generateAndAwait('node'), false);
  assert.equal(creates, 1);
});

test('slow submission survives old 120s timeout and 180s reclamation threshold', async () => {
  reset();
  let complete;
  const originalTimeout = AbortSignal.timeout;
  let budget;
  AbortSignal.timeout = ms => { budget = ms; return originalTimeout(ms); };
  respond = () => new Promise(resolve => { complete = resolve; });
  try {
    const a = queue.enqueueVideo('p', 'slow', body);
    const pending = queue.submitQueuedVideo();
    assert.equal(budget, 240_000);
    queue.enqueueVideo('p', 'next', body);
    time += 200_000;
    await queue.submitQueuedVideo();
    assert.equal(task(a.id).status, 'queued', 'slow live request must not be reclaimed');
    assert.equal(requests.length, 1, 'must not submit a second task');
    complete(response(200, { id: 'slow-accepted' }));
    await pending;
    assert.equal(task(a.id).status, 'in_progress');
    assert.equal(task(a.id).agnes_task_id, 'slow-accepted');
  } finally { AbortSignal.timeout = originalTimeout; }
});

test('header and body timeouts are classified and retained without resubmission', async () => {
  for (const phase of ['headers', 'body']) {
    reset();
    const originalTimeout = AbortSignal.timeout;
    let controller;
    AbortSignal.timeout = () => { controller = new AbortController(); return controller.signal; };
    const fail = () => { time += 240_000; controller.abort(new DOMException('deadline', 'TimeoutError')); throw controller.signal.reason; };
    respond = () => phase === 'headers' ? fail() : { text: async () => fail() };
    try {
      const a = queue.enqueueVideo('p', 'timeout', body);
      await queue.submitQueuedVideo();
      assert.match(task(a.id).error, /超过 240 秒/);
      assert.doesNotMatch(task(a.id).error, /网络连接失败/);
      const event = JSON.parse(db.prepare('SELECT detail FROM video_submission_diagnostics WHERE task_id=?').get(a.id).detail);
      assert.equal(event.kind, 'timeout'); assert.equal(event.phase, phase);
      assert.equal(event.elapsedMs, 240_000); assert.equal(event.timeoutMs, 240_000);
      assert.equal(queue.submissionInfo(a.id), undefined);
      await queue.submitQueuedVideo(); assert.equal(requests.length, 1);
    } finally { AbortSignal.timeout = originalTimeout; }
  }
});

test('network, upstream HTTP and malformed response failures stay distinguishable', async () => {
  const cases = [
    { kind: 'network', reply: () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }, message: /网络连接失败.*ECONNRESET/ },
    { kind: 'upstream_http', reply: () => response(504, {}, { 'x-request-id': 'gateway-test-id' }), message: /HTTP 504/ },
    { kind: 'invalid_response', reply: () => response(200, { status: 'ok' }), message: /响应格式异常/ },
  ];
  for (const item of cases) {
    reset(); respond = item.reply;
    const a = queue.enqueueVideo('p', item.kind, body); await queue.submitQueuedVideo();
    assert.equal(task(a.id).status, 'failed'); assert.match(task(a.id).error, item.message);
    const event = JSON.parse(db.prepare('SELECT detail FROM video_submission_diagnostics WHERE task_id=?').get(a.id).detail);
    assert.equal(event.kind, item.kind);
    if (item.kind === 'upstream_http') assert.equal(event.requestId, 'gateway-test-id');
    assert.ok(!JSON.stringify(event).includes('test-only'));
    time += 1_000_000; await queue.submitQueuedVideo(); assert.equal(requests.length, 1);
  }
});

test('late explicit queue-full response remains eligible for retry', async () => {
  reset(); respond = () => { time += 150_000; return response(503, { code: 'video_queue_full' }); };
  const a = queue.enqueueVideo('p', 'slow-rejection', body);
  await queue.submitQueuedVideo();
  assert.equal(task(a.id).status, 'queued');
  const event = JSON.parse(db.prepare('SELECT detail FROM video_submission_diagnostics WHERE task_id=?').get(a.id).detail);
  assert.equal(event.kind, 'upstream_http'); assert.equal(event.elapsedMs, 150_000);
  assert.equal(event.upstreamCode, 'video_queue_full');
});
