import assert from 'node:assert/strict';
import test from 'node:test';
import { startAutosave } from '../src/autosave.mjs';
import { PhpSession } from '../src/playground.mjs';

function scheduler() {
  let callback, delay;
  return {
    setTimer(next, ms) { assert.equal(callback, undefined, 'Only one autosave timer may be pending.'); callback = next; delay = ms; return 1; },
    clearTimer() { callback = undefined; },
    get delay() { return callback ? delay : null; },
    async tick() { const next = callback; callback = undefined; assert.ok(next); return next(); },
  };
}

test('autosave waits for idle and schedules its next interval after saving finishes', async () => {
  const timers = scheduler();
  let ready = false, release, calls = 0;
  const { stop } = startAutosave({ canSave: () => ready, save: () => { calls++; return new Promise(resolve => { release = resolve; }); },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  assert.equal(timers.delay, 60_000);
  await timers.tick();
  assert.equal(calls, 0);
  assert.equal(timers.delay, 5_000);
  ready = true;
  const saving = timers.tick();
  assert.equal(calls, 1);
  assert.equal(timers.delay, null, 'A slow save never accumulates overlapping periodic work.');
  release(); await saving;
  assert.equal(timers.delay, 60_000);
  const pending = timers.tick();
  stop(); release(); await pending;
  assert.equal(timers.delay, null, 'Stopping during a save must not restart its timer.');
});

test('autosave reports storage errors and retries on the next interval', async () => {
  const timers = scheduler(), errors = [];
  const failure = new Error('Storage is full');
  const { stop } = startAutosave({ canSave: () => true, save: async () => { throw failure; }, onError: error => errors.push(error),
    setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  await timers.tick();
  assert.deepEqual(errors, [failure]);
  assert.equal(timers.delay, 60_000);
  stop();
});

test('the first checkpoint is requested promptly after launch and still waits for runtime idle', async () => {
  const timers = scheduler();
  let ready = false, calls = 0;
  const autosave = startAutosave({ canSave: () => ready, save: async () => { calls++; },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  autosave.request();
  assert.equal(timers.delay, 1_000, 'The initial checkpoint must not wait for the regular minute interval.');
  await timers.tick();
  assert.equal(calls, 0);
  ready = true;
  await timers.tick();
  assert.equal(calls, 1);
  assert.equal(timers.delay, 60_000);
  autosave.stop();
});

test('a manual save restarts the interval instead of triggering another pending autosave', async () => {
  const timers = scheduler();
  let calls = 0;
  const autosave = startAutosave({ canSave: () => true, save: async () => { calls++; },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  autosave.request();
  assert.equal(timers.delay, 1_000);
  autosave.saved();
  assert.equal(timers.delay, 60_000);
  assert.equal(calls, 0);
  await timers.tick();
  assert.equal(calls, 1);
  autosave.stop();
});

test('runtime stays busy across the filesystem and database flush and queues later writes', async () => {
  const previous = globalThis.Worker;
  globalThis.Worker = class {
    messages = [];
    addEventListener() {}
    postMessage(message) { this.messages.push(message); }
    terminate() {}
  };
  let finishDatabase;
  const session = new PhpSession({ flush: () => new Promise(resolve => { finishDatabase = resolve; }), reset: async () => {} });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(session.idle, true);
    const write = session.send('fs.writeFile', { path: '/file', data: 'first' });
    assert.equal(session.idle, false);
    await drain();
    await session.receive({ type: 'result', id: session.worker.messages.at(-1).id, value: null });
    await write;
    assert.equal(session.idle, true);
    const saving = session.flushTogether();
    assert.equal(session.idle, false);
    const later = session.send('fs.writeFile', { path: '/file', data: 'second' });
    await drain();
    assert.equal(session.worker.messages.at(-1).operation, 'flush');
    await session.receive({ type: 'result', id: session.worker.messages.at(-1).id, value: null });
    await drain();
    assert.equal(session.idle, false, 'Completing the filesystem is not the end of a database save.');
    assert.equal(session.worker.messages.at(-1).operation, 'flush', 'A later write cannot split the two persistent stores.');
    finishDatabase(); await saving; await drain();
    assert.equal(session.worker.messages.at(-1).args.data, 'second');
    await session.receive({ type: 'result', id: session.worker.messages.at(-1).id, value: null });
    await later;
    assert.equal(session.idle, true);
  } finally {
    session.fail(new Error('Test complete'));
    if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous;
  }
});
