import assert from 'node:assert/strict';
import test from 'node:test';
import { installationBudget, DEFAULT_PHP_SETTINGS } from '../src/php-settings.mjs';
import { PhpSession } from '../src/playground.mjs';

test('installation allowance is independent of ordinary request defaults and reserves shutdown time', () => {
  assert.equal(DEFAULT_PHP_SETTINGS.max_execution_time, 60);
  assert.deepEqual(installationBudget(), { executionTimeSeconds: 180, timeoutMs: 210_000 });
  assert.deepEqual(installationBudget({ executionTimeSeconds: 300 }), { executionTimeSeconds: 300, timeoutMs: 330_000 });
  assert.deepEqual(installationBudget({ executionTimeSeconds: 10, timeoutMs: 600_000 }), { executionTimeSeconds: 10, timeoutMs: 600_000 });
  for (const executionTimeSeconds of [0, 4, 301, 60.1, '180', NaN, null]) {
    assert.throws(() => installationBudget({ executionTimeSeconds }), /between 5 and 300/);
  }
  for (const timeoutMs of [0, 180_000, 209_999, 600_001, '210000', 210_000.5]) {
    assert.throws(() => installationBudget({ timeoutMs }), /including 30 seconds/);
  }
});

test('provisioning watchdog starts after FIFO queue and stops a failed worker without replay', async () => {
  const previous = { Worker: globalThis.Worker, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map();
  let timerSequence = 0;
  globalThis.Worker = class {
    messages = [];
    addEventListener() {}
    postMessage(value) { this.messages.push(value); }
    terminate() { this.terminated = true; }
  };
  globalThis.setTimeout = (callback, delay) => { const id = ++timerSequence; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const session = new PhpSession(null);
  const drain = () => new Promise(resolve => setImmediate(resolve));
  const first = session.send('runPhp', { source: 'first' }, 210_000);
  const queued = session.send('runPhp', { source: 'queued' }, 330_000);
  first.catch(() => {}); queued.catch(() => {});
  try {
    await drain();
    assert.equal(session.worker.messages.length, 1);
    assert.deepEqual([...timers.values()].map(value => value.delay), [210_000]);
    await session.receive({ type: 'result', id: session.worker.messages[0].id, value: { status: 200 } });
    await first;
    await drain();
    assert.equal(session.worker.messages.length, 2);
    assert.deepEqual([...timers.values()].map(value => value.delay), [330_000]);
    [...timers.values()][0].callback();
    await assert.rejects(queued, error => error.code === 'TIMEOUT' && /330000 ms/.test(error.message));
    assert.equal(session.worker.terminated, true);
    await assert.rejects(session.send('runPhp', { source: 'retry' }), /not replayed/);
    assert.equal(session.worker.messages.length, 2);
  } finally {
    session.fail(new Error('Test finished.'));
    await Promise.allSettled([first, queued]);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});
