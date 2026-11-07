import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPhpRequestWorker, createPhpSelfRequestFetch } from '../src/php-self-request.mjs';

// Exercise the filesystem handoff against actual files, without booting WASM.
function filesystem(t, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'joomengine-http-callback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = name => path.join(root, name);
  const result = {
    analyzePath: name => ({ exists: fs.existsSync(local(name)) }),
    lstat: name => fs.lstatSync(local(name)),
    stat: name => fs.statSync(local(name)),
    isLink: mode => (mode & 0o170000) === 0o120000,
    isDir: mode => (mode & 0o170000) === 0o040000,
    isFile: mode => (mode & 0o170000) === 0o100000,
    readdir: name => fs.readdirSync(local(name)),
    readFile: name => fs.readFileSync(local(name)),
    writeFile: (name, bytes) => fs.writeFileSync(local(name), bytes),
    mkdirTree: name => fs.mkdirSync(local(name), { recursive: true }),
    chmod: (name, mode) => fs.chmodSync(local(name), mode),
    utime: (name, atime, mtime) => fs.utimesSync(local(name), atime, mtime),
    unlink: name => fs.unlinkSync(local(name)),
    rmdir: name => fs.rmdirSync(local(name)),
  };
  for (const directory of ['/persist/www', '/config']) result.mkdirTree(directory);
  for (const [name, value] of Object.entries(files)) result.writeFile(name, value);
  return result;
}

function callbackWorkers({ cancelled } = {}) {
  const started = Promise.withResolvers();
  const workers = [];
  class CallbackWorker {
    constructor() { workers.push(this); this.terminated = 0; this.messages = []; }
    postMessage(message) {
      this.messages.push(message);
      if (message.operation === 'initialize') {
        this.initialization = message.args;
        queueMicrotask(() => this.emit({ type: 'result', id: message.id, value: {} }));
      } else if (message.operation === 'selfRequest') {
        this.request = message.args;
        started.resolve(this);
      } else if (message.type === 'cancel-self-request') cancelled?.(this);
    }
    emit(message) { return this.onmessage({ data: message }); }
    callDatabase(input) {
      return this.emit({ type: 'database-call', id: this.messages.length, payload: JSON.stringify({ version: 1, ...input }) });
    }
    complete(snapshot = this.initialization.snapshot, response = {}) {
      return this.emit({ type: 'result', id: 2, value: { snapshot, response: {
        status: 200, statusText: 'OK', headers: [], body: new Uint8Array(), ...response,
      } } });
    }
    terminate() { this.terminated++; }
  }
  return { WorkerType: CallbackWorker, workers, started: started.promise };
}

function database() {
  const active = new Set(['parent-transaction']);
  const calls = [];
  let sequence = 0;
  return { active, calls, async call(payload) {
    const input = JSON.parse(payload);
    calls.push(input);
    let result = {};
    if (input.op === 'connect') {
      const connection = `callback-${++sequence}`;
      active.add(connection);
      result = { connection };
    } else if (input.op === 'close') {
      assert.ok(active.delete(input.connection), 'a connection must be closed exactly once');
    } else assert.fail(`Unexpected database operation: ${input.op}`);
    return JSON.stringify({ version: 1, ok: true, result });
  } };
}

function childFile(snapshot, name, text) {
  const next = new Map(structuredClone(snapshot));
  next.set(name, { mode: 0o100644, atime: new Date(0), mtime: new Date(0), bytes: new TextEncoder().encode(text) });
  return [...next];
}

test('HTTP callback preserves binary CGI input/output and file changes without changing the owner cookie jar', async t => {
  const owner = filesystem(t, { '/config/.cookies': 'owner-cookie', '/persist/www/removed.txt': 'old' });
  const workers = callbackWorkers();
  const db = database();
  const request = createPhpRequestWorker({ options: { persistence: true, debugger: {} },
    getFilesystem: () => owner, databaseCall: db.call, WorkerType: workers.WorkerType });
  const bytes = new Uint8Array([0, 255, 65, 128, 10]);
  const pending = request(new Request('https://site.test/joomla/callback.php?x=1', {
    method: 'POST', headers: { cookie: 'callback=explicit', 'content-type': 'application/octet-stream' }, body: bytes,
  }));
  const worker = await workers.started;
  assert.equal(worker.request.url, 'https://site.test/joomla/callback.php?x=1');
  assert.equal(worker.request.method, 'POST');
  assert.equal(new Headers(worker.request.headers).get('cookie'), 'callback=explicit');
  assert.deepEqual(worker.request.body, bytes);
  assert.equal(worker.initialization.persistence, false);
  await worker.callDatabase({ op: 'connect' });
  let next = childFile(worker.initialization.snapshot, '/config/.cookies', 'callback-cookie');
  next = childFile(next, '/persist/www/result.txt', 'child-complete').filter(([name]) => name !== '/persist/www/removed.txt');
  await worker.complete(next, { status: 201, statusText: 'Created', headers: [['content-type', 'application/octet-stream']], body: bytes });
  const response = await pending;
  assert.equal(response.status, 201);
  assert.equal(response.statusText, 'Created');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(owner.readFile('/config/.cookies').toString(), 'owner-cookie');
  assert.equal(owner.readFile('/persist/www/result.txt').toString(), 'child-complete');
  assert.equal(owner.analyzePath('/persist/www/removed.txt').exists, false);
  assert.deepEqual([...db.active], ['parent-transaction']);
  assert.equal(worker.terminated, 1);
});

for (const failure of ['PHP error', 'Worker error']) {
  test(`${failure} closes only callback connections, including connections not explicitly closed by PHP`, async t => {
    const owner = filesystem(t);
    const workers = callbackWorkers();
    const db = database();
    const request = createPhpRequestWorker({ options: {}, getFilesystem: () => owner,
      databaseCall: db.call, WorkerType: workers.WorkerType });
    const pending = request(new Request('https://site.test/callback.php'));
    const rejected = assert.rejects(pending, /callback failed/);
    const worker = await workers.started;
    await worker.callDatabase({ op: 'connect' });
    await worker.callDatabase({ op: 'connect' });
    await worker.callDatabase({ op: 'close', connection: 'callback-1' });
    if (failure === 'PHP error') await worker.emit({ type: 'result', id: 2, error: 'PHP callback failed' });
    else worker.onerror({ message: 'Worker callback failed' });
    await rejected;
    assert.deepEqual(db.calls.filter(call => call.op === 'close').map(call => call.connection), ['callback-1', 'callback-2']);
    assert.deepEqual([...db.active], ['parent-transaction']);
    assert.equal(worker.terminated, 1);
  });
}

test('cancellation returns completed writes and closes a late database connection before the parent resumes', async t => {
  const owner = filesystem(t, { '/config/.cookies': 'owner-cookie' });
  const workers = callbackWorkers({ cancelled(worker) {
    let next = childFile(worker.initialization.snapshot, '/persist/www/result.txt', 'committed-before-cancel');
    next = childFile(next, '/config/.cookies', 'callback-cookie');
    void worker.emit({ type: 'self-request-cancelled', snapshot: next });
  } });
  const db = database();
  const connecting = Promise.withResolvers();
  const controller = new AbortController();
  const reason = new DOMException('The caller stopped waiting.', 'AbortError');
  const request = createPhpRequestWorker({ options: {}, getFilesystem: () => owner, WorkerType: workers.WorkerType,
    databaseCall: async payload => {
      if (JSON.parse(payload).op === 'connect') await connecting.promise;
      return db.call(payload);
    } });
  const pending = request(new Request('https://site.test/callback.php', { signal: controller.signal }));
  const outcome = pending.catch(error => error);
  let settled = false;
  void outcome.then(() => { settled = true; });
  const worker = await workers.started;
  const connection = worker.callDatabase({ op: 'connect' });
  controller.abort(reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the parent waits for database ownership to be resolved');
  connecting.resolve();
  await connection;
  assert.equal(await outcome, reason);
  assert.equal(owner.readFile('/persist/www/result.txt').toString(), 'committed-before-cancel');
  assert.equal(owner.readFile('/config/.cookies').toString(), 'owner-cookie');
  assert.deepEqual(db.calls.filter(call => call.op === 'close').map(call => call.connection), ['callback-1']);
  assert.deepEqual([...db.active], ['parent-transaction']);
  assert.equal(worker.terminated, 1);
  owner.writeFile('/persist/www/result.txt', 'parent-resumed');
  await worker.emit({ type: 'self-request-cancelled', snapshot:
    childFile(worker.initialization.snapshot, '/persist/www/result.txt', 'late-child-write') });
  assert.equal(owner.readFile('/persist/www/result.txt').toString(), 'parent-resumed');
});

test('an unresponsive cancelled callback is terminated and releases its database connections', async t => {
  const owner = filesystem(t);
  const workers = callbackWorkers();
  const db = database();
  const controller = new AbortController();
  const request = createPhpRequestWorker({ options: {}, getFilesystem: () => owner,
    databaseCall: db.call, WorkerType: workers.WorkerType });
  const pending = request(new Request('https://site.test/callback.php', { signal: controller.signal }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const worker = await workers.started;
  await worker.callDatabase({ op: 'connect' });
  controller.abort();
  await rejected;
  assert.equal(worker.terminated, 1);
  assert.deepEqual([...db.active], ['parent-transaction']);
});

test('a callback cannot create an owner cookie jar that did not already exist', async t => {
  const owner = filesystem(t);
  const workers = callbackWorkers();
  const request = createPhpRequestWorker({ options: {}, getFilesystem: () => owner,
    databaseCall: async () => assert.fail('No database call expected'), WorkerType: workers.WorkerType });
  const pending = request(new Request('https://site.test/callback.php'));
  const worker = await workers.started;
  await worker.complete(childFile(worker.initialization.snapshot, '/config/.cookies', 'callback-cookie'));
  await pending;
  assert.equal(owner.analyzePath('/config/.cookies').exists, false);
});

test('self-request delivery preserves 307 upload bytes, explicit headers and redirect metadata', async () => {
  const requests = [];
  const bytes = new Uint8Array([0, 255, 65, 128, 10]);
  const fetch = createPhpSelfRequestFetch({ siteURL: 'https://site.test/joomla/',
    transport: async () => assert.fail('A local callback does not use external delivery'),
    request: async request => {
      requests.push({ url: request.url, method: request.method, cookie: request.headers.get('cookie'),
        bytes: new Uint8Array(await request.arrayBuffer()) });
      return request.url.endsWith('/first.php')
        ? new Response(null, { status: 307, headers: { location: './final.php' } })
        : new Response(bytes, { status: 201 });
    } });
  const response = await fetch(new Request('https://site.test/joomla/first.php', {
    method: 'POST', body: bytes, headers: { cookie: 'callback=explicit' },
  }), { network: { maxRedirects: 1 } });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.cookie, 'callback=explicit');
    assert.deepEqual(request.bytes, bytes);
  }
  assert.equal(response.status, 201);
  assert.equal(response.url, 'https://site.test/joomla/final.php');
  assert.equal(response.redirected, true);
  assert.equal(response.networkRedirectCount, 1);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('self-request transport waits for child cancellation before rejecting the suspended caller', async () => {
  const started = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const controller = new AbortController();
  const fetch = createPhpSelfRequestFetch({ siteURL: 'https://site.test/joomla/',
    transport: async () => assert.fail('No external delivery expected'),
    request: async request => {
      started.resolve();
      await cancelled.promise;
      request.signal.throwIfAborted();
      return new Response('complete');
    } });
  const pending = fetch('https://site.test/joomla/callback.php', { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'REQUEST_ABORTED' });
  let settled = false;
  void rejected.then(() => { settled = true; });
  await started.promise;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  cancelled.resolve();
  await rejected;
});
