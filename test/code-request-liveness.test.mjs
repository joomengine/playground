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
