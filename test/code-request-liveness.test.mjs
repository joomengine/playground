import test from 'node:test';
import assert from 'node:assert/strict';
import { PhpSession } from '../src/playground.mjs';

const previousSelf = globalThis.self;
globalThis.self = { registration: { scope: 'https://example.test/' }, addEventListener() {} };
const { waitForPlaygroundResponse } = await import('../service-worker.mjs');
if (previousSelf === undefined) delete globalThis.self;
else globalThis.self = previousSelf;

function responseHarness(ownerAlive) {
  const timers = new Map();
  let sequence = 0;
  const port = { closed: false, close() { this.closed = true; },
    message(data) { this.onmessage({ data }); } };
  const waiting = waitForPlaygroundResponse({ port, ownerAlive,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  waiting.promise.catch(() => {});
  return { ...waiting, port, timers,
    async tick(expectedDelay) {
      assert.equal(timers.size, 1);
      const [id, value] = [...timers][0];
      assert.equal(value.delay, expectedDelay);
      timers.delete(id);
      return value.callback();
    },
  };
}

const state = value => ({ type: 'playground-request-state', state: value });

test('paused responses survive long background-owner throttling and detect actual owner loss', async () => {
  let alive = true, checks = 0;
  const response = responseHarness(async () => { checks++; return alive; });
  response.port.message(state('paused'));
  // Over ten minutes with no heartbeat or message from the throttled owner.
  for (let index = 0; index < 41; index++) await response.tick(15_000);
  assert.equal(response.port.closed, false);
  assert.equal(checks, 41);
  alive = false;
  const rejected = assert.rejects(response.promise, /lost its owner tab/);
  await response.tick(15_000);
  await rejected;
  assert.equal(response.port.closed, true);
  assert.equal(response.timers.size, 0);
});

test('late owner checks cannot override resume or a completed PHP response', async () => {
  let answer;
  const response = responseHarness(() => new Promise(resolve => { answer = resolve; }));
  response.port.message(state('paused'));
  const checking = response.tick(15_000);
  response.port.message(state('running'));
  answer(false);
  await checking;
  assert.equal(response.port.closed, false);
  assert.equal([...response.timers.values()][0].delay, 600_000);
  response.port.message(state('paused'));
  const completing = response.tick(15_000);
  response.port.message({ status: 200, body: new Uint8Array([1]) });
  answer(false);
  await completing;
  assert.equal((await response.promise).status, 200);
  assert.equal(response.timers.size, 0);
});

test('ordinary responses retain their bounded execution deadline', async () => {
  const response = responseHarness(async () => true);
  const rejected = assert.rejects(response.promise, /within 600 seconds/);
  await response.tick(600_000);
  await rejected;
  assert.equal(response.port.closed, true);
});

test('selected and queued HTTP requests share pause progress without blocking debugger commands', async () => {
  const previousWorker = globalThis.Worker;
  class Worker {
    messages = [];
    addEventListener() {}
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = Worker;
  const session = new PhpSession(null);
  const pending = [];
  try {
    const selectedStates = [], queuedStates = [], laterStates = [];
    const request = listener => {
      const value = session.send('request', {}, 600_000, listener);
      value.catch(() => {}); pending.push(value); return value;
    };
    const selected = request(value => selectedStates.push(value));
    const queued = request(value => queuedStates.push(value));
    await Promise.resolve();
    const selectedId = session.worker.messages[0].id;
    await session.receive({ type: 'debug-state', state: 'paused', requestId: selectedId });
    const later = request(value => laterStates.push(value));
    assert.deepEqual(selectedStates, ['paused']);
    assert.deepEqual(queuedStates, ['paused']);
    assert.deepEqual(laterStates, ['paused']);
    assert.equal(session.worker.messages.length, 1, 'Queued requests must not execute beside paused PHP');

    const inspect = session.debugCommand('stackTrace');
    inspect.catch(() => {}); pending.push(inspect);
    const inspection = session.worker.messages.at(-1);
    assert.equal(inspection.type, 'debug-command');
    await session.receive({ type: 'result', id: inspection.id, value: [] });
    assert.deepEqual(await inspect, []);

    await session.receive({ type: 'debug-state', state: 'running', requestId: selectedId });
    for (const values of [selectedStates, queuedStates, laterStates]) assert.deepEqual(values, ['paused', 'running']);
    await session.receive({ type: 'debug-state', state: 'idle', requestId: selectedId });
    await session.receive({ type: 'result', id: selectedId, value: { databaseUsed: false, status: 200 } });
    await selected;
    await Promise.resolve();
    const queuedId = session.worker.messages.at(-1).id;
    assert.notEqual(queuedId, selectedId);
    await session.receive({ type: 'result', id: queuedId, value: { databaseUsed: false, status: 200 } });
    await queued;
    await Promise.resolve();
    const laterId = session.worker.messages.at(-1).id;
    assert.notEqual(laterId, queuedId);
    await session.receive({ type: 'result', id: laterId, value: { databaseUsed: false, status: 200 } });
    await later;
    assert.equal(session.requestProgress.size, 0);
    assert.equal(session.pending.size, 0);
    assert.equal(session.queued, 0);
  } finally {
    session.fail(new Error('Test session ended.'));
    await Promise.allSettled(pending);
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
});

async function withSession(callback) {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = class {
    messages = [];
    addEventListener() {}
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  const session = new PhpSession(null), pending = [];
  const track = promise => { promise.catch(() => {}); pending.push(promise); return promise; };
  const drain = () => new Promise(resolve => setImmediate(resolve));
  const result = (message, value) => session.receive({ type: 'result', id: message.id, value });
  try { await callback({ session, track, drain, result }); }
  finally {
    session.fail(new Error('Test session ended.'));
    await Promise.allSettled(pending);
    await session.queue;
    if (previousWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = previousWorker;
  }
}

test('paused workspace reads bypass selected PHP and queued writes without replaying either', async () => {
  await withSession(async ({ session, track, drain, result }) => {
    const selected = track(session.send('request'));
    const firstWrite = track(session.workspaceRequest('write', { path: '/first.php' }));
    const operations = ['read', 'stat', 'list', 'search', 'cancelSearch'];
    const queuedReads = operations.map(operation => track(session.workspaceRequest(operation, { path: '/source.php' })));
    const secondWrite = track(session.workspaceRequest('write', { path: '/second.php' }));
    await drain();
    const selectedMessage = session.worker.messages[0];
    assert.equal(session.worker.messages.length, 1);
    await session.receive({ type: 'debug-state', state: 'paused', requestId: selectedMessage.id });
    const pausedRead = track(session.workspaceRequest('read', { path: '/callee.php' }));
    const reads = session.worker.messages.slice(1);
    assert.deepEqual(reads.map(message => message.command), Array(6).fill('workspaceRead'));
    assert.deepEqual(reads.map(message => message.args.operation), [...operations, 'read']);
    for (const [index, message] of reads.entries()) await result(message, { activeSnapshot: index });
    assert.deepEqual(await Promise.all([...queuedReads, pausedRead]), reads.map((_, activeSnapshot) => ({ activeSnapshot })));
    assert.equal(session.worker.messages.length, 7, 'No mutation executes in the paused filesystem');
    await session.receive({ type: 'debug-state', state: 'running', requestId: selectedMessage.id });
    await drain();
    assert.equal(session.worker.messages.length, 7, 'Running is not yet a completed filesystem handoff');
    await result(selectedMessage, { databaseUsed: false, status: 200 });
    await selected; await drain();
    const first = session.worker.messages.at(-1);
    assert.equal(first.operation, 'workspace.write'); assert.equal(first.args.path, '/first.php');
    await result(first, 'first saved'); await firstWrite; await drain();
    const second = session.worker.messages.at(-1);
    assert.equal(second.operation, 'workspace.write'); assert.equal(second.args.path, '/second.php');
    await result(second, 'second saved'); await secondWrite; await session.queue;
    assert.deepEqual(session.worker.messages.filter(message => message.type === 'operation').map(message => message.operation), ['request', 'workspace.write', 'workspace.write']);
    assert.equal(session.workspaceReads.size, 0); assert.equal(session.pending.size, 0); assert.equal(session.queued, 0);
  });
});

test('a read racing Continue retries only after filesystem handoff and earlier writes', async () => {
  await withSession(async ({ session, track, drain, result }) => {
    const selected = track(session.send('request'));
    const write = track(session.workspaceRequest('write', { path: '/caller.php' }));
    const queuedRead = track(session.workspaceRequest('stat', { path: '/caller.php' }));
    await drain();
    const selectedMessage = session.worker.messages[0];
    await session.receive({ type: 'debug-state', state: 'paused', requestId: selectedMessage.id });
    const newRead = track(session.workspaceRequest('read', { path: '/callee.php' }));
    const direct = session.worker.messages.slice(1);
    await session.receive({ type: 'debug-state', state: 'running', requestId: selectedMessage.id });
    for (const message of direct) await session.receive({ type: 'result', id: message.id, error: 'PHP resumed', code: 'DEBUG_NOT_PAUSED' });
    await drain();
    assert.equal(session.worker.messages.length, 3, 'Must not inspect the stale CGI filesystem while PHP still owns it');
    await result(selectedMessage, { databaseUsed: false }); await selected; await drain();
    assert.equal(session.worker.messages.at(-1).operation, 'workspace.write');
    await result(session.worker.messages.at(-1), 'saved'); await write; await drain();
    assert.equal(session.worker.messages.at(-1).operation, 'workspace.stat');
    await result(session.worker.messages.at(-1), { revision: 'after-save' });
    assert.deepEqual(await queuedRead, { revision: 'after-save' }); await drain();
    assert.equal(session.worker.messages.at(-1).operation, 'workspace.read');
    await result(session.worker.messages.at(-1), { source: 'returned filesystem' });
    assert.deepEqual(await newRead, { source: 'returned filesystem' }); await session.queue;
    assert.equal(session.workspaceReads.size, 0); assert.equal(session.pending.size, 0); assert.equal(session.queued, 0);
  });
});

test('paused read confinement errors are not retried through another filesystem', async () => {
  await withSession(async ({ session, track, drain }) => {
    const selected = track(session.send('request')); await drain();
    await session.receive({ type: 'debug-state', state: 'paused', requestId: session.worker.messages[0].id });
    const read = track(session.workspaceRequest('read', { path: '/outside.php' }));
    await session.receive({ type: 'result', id: session.worker.messages.at(-1).id, error: 'Outside workspace', code: 'OUTSIDE_WORKSPACE' });
    await assert.rejects(read, error => error.code === 'OUTSIDE_WORKSPACE');
    await drain(); assert.equal(session.worker.messages.length, 2);
    assert.equal(session.workspaceReads.size, 0);
    session.fail(new Error('Owner closed'));
    await assert.rejects(selected, /Owner closed/);
  });
});

test('paused inspection has bounded capacity independent of a saturated HTTP queue and fails cleanly', async () => {
  await withSession(async ({ session, track, drain }) => {
    const requests = Array.from({ length: 64 }, () => track(session.send('request')));
    await drain();
    await session.receive({ type: 'debug-state', state: 'paused', requestId: session.worker.messages[0].id });
    const reads = Array.from({ length: 64 }, (_, index) => track(session.workspaceRequest('read', { path: `/source-${index}.php` })));
    assert.equal(session.worker.messages.length, 65);
    await assert.rejects(session.workspaceRequest('read'), /queue is full/);
    await assert.rejects(session.workspaceRequest('write'), /queue is full/);
    session.fail(new Error('Owner disappeared'));
    for (const promise of [...requests, ...reads]) await assert.rejects(promise, /Owner disappeared/);
    await session.queue;
    assert.equal(session.workspaceReads.size, 0); assert.equal(session.pending.size, 0); assert.equal(session.queued, 0);
    assert.equal(session.worker.terminated, true);
  });
});

test('a delayed read rejection from an earlier pause uses the newer paused snapshot', async () => {
  await withSession(async ({ session, track, drain, result }) => {
    const selected = track(session.send('request')); await drain();
    const requestId = session.worker.messages[0].id;
    await session.receive({ type: 'debug-state', state: 'paused', requestId });
    const read = track(session.workspaceRequest('read', { path: '/callee.php' }));
    const oldRead = session.worker.messages.at(-1);
    await session.receive({ type: 'debug-state', state: 'running', requestId });
    await session.receive({ type: 'debug-state', state: 'paused', requestId });
    assert.equal(session.worker.messages.length, 2, 'The first read is still awaiting its response');
    await session.receive({ type: 'result', id: oldRead.id, error: 'The earlier pause resumed', code: 'DEBUG_NOT_PAUSED' });
    await drain();
    const newRead = session.worker.messages.at(-1);
    assert.notEqual(newRead.id, oldRead.id);
    assert.equal(newRead.command, 'workspaceRead');
    await result(newRead, { source: 'second paused snapshot' });
    assert.deepEqual(await read, { source: 'second paused snapshot' });
    assert.equal(session.worker.messages.length, 3);
    assert.equal(session.workspaceReads.size, 0);
    session.fail(new Error('End paused owner'));
    await assert.rejects(selected, /End paused owner/);
  });
});

test('closing the owner settles a delayed paused read and clears its command timer', async () => {
  await withSession(async ({ session, track, drain, result }) => {
    let failures = 0; session.onFailure = () => { failures++; };
    const selected = track(session.send('request')); await drain();
    const selectedMessage = session.worker.messages[0];
    await session.receive({ type: 'debug-state', state: 'paused', requestId: selectedMessage.id });
    const read = track(session.workspaceRequest('read', { path: '/callee.php' }));
    const heldRead = session.worker.messages.at(-1);
    const closing = track(session.close());
    const stopping = session.worker.messages.at(-1);
    assert.equal(stopping.command, 'stop');
    await result(stopping, {});
    await result(selectedMessage, { databaseUsed: false }); await selected; await drain();
    const closeMessage = session.worker.messages.at(-1);
    assert.equal(closeMessage.operation, 'close');
    await result(closeMessage, {}); await closing;
    await assert.rejects(read, /session is closed/);
    assert.equal(session.pending.size, 0); assert.equal(session.workspaceReads.size, 0); assert.equal(session.queued, 0);
    assert.equal(session.worker.terminated, true); assert.equal(failures, 0, 'Normal closure must not report a runtime crash');
    await result(heldRead, { stale: true });
    assert.equal(session.pending.size, 0, 'A delayed reply after closure cannot revive the session');
  });
});
