import assert from 'node:assert/strict';
import test from 'node:test';
import { createLivePersistence } from '../src/live-persistence.mjs';

const drain = () => new Promise(resolve => setImmediate(resolve));
function clock() {
  let id = 0;
  const timers = new Map();
  return { timers,
    setTimer(callback, delay) { timers.set(++id, { callback, delay }); return id; },
    clearTimer(key) { timers.delete(key); },
    async fire() {
      const [key, timer] = timers.entries().next().value;
      timers.delete(key); timer.callback(); await drain(); return timer.delay;
    },
  };
}

test('live persistence coalesces completed changes without waiting for the periodic autosave', async () => {
  const time = clock();
  let dirty = false, saves = 0;
  const controller = createLivePersistence({ ...time, isDirty: () => dirty,
    save: async () => { saves++; dirty = false; } });
  controller.enable();
  assert.equal(time.timers.size, 0);
  dirty = true;
  controller.changed(); controller.changed(); controller.changed();
  assert.equal(time.timers.size, 1);
  assert.equal(await time.fire(), 100);
  assert.equal(saves, 1);
  assert.equal(time.timers.size, 0);
  controller.dispose();
});

test('save failures back off without losing later live changes and manual success resets retries', async () => {
  const time = clock();
  let dirty = true, attempts = 0;
  const errors = [];
  const controller = createLivePersistence({ ...time, isDirty: () => dirty,
    save: async () => { attempts++; throw new DOMException('', 'QuotaExceededError'); },
    onError: error => errors.push(error) });
  controller.enable();
  assert.equal(await time.fire(), 100);
  controller.changed(); controller.changed();
  assert.equal(time.timers.size, 1);
  assert.equal(await time.fire(), 5_000);
  assert.equal(await time.fire(), 10_000);
  assert.equal(attempts, 3);
  assert.equal(errors.length, 3);
  dirty = false; controller.saved();
  assert.equal(time.timers.size, 0);
  dirty = true; controller.changed();
  assert.equal(await time.fire(), 100);
  controller.dispose();
  assert.equal(time.timers.size, 0);
});

test('mutations arriving during a save receive a later checkpoint without parallel saves', async () => {
  const time = clock();
  let version = 1, saved = 0, complete, calls = 0;
  const controller = createLivePersistence({ ...time, isDirty: () => version !== saved,
    save: () => { const captured = version; calls++; return new Promise(resolve => {
      complete = () => { saved = captured; resolve(); };
    }); } });
  controller.enable(); await time.fire();
  version++; controller.changed();
  assert.equal(time.timers.size, 0);
  complete(); await drain();
  assert.equal(time.timers.size, 1);
  await time.fire(); complete(); await drain();
  assert.equal(calls, 2);
  assert.equal(saved, version);
  assert.equal(time.timers.size, 0);
  controller.dispose();
});

test('a paused operation postpones saving and disposal cancels pending retries', async () => {
  const time = clock();
  let allowed = false, saved = false;
  const controller = createLivePersistence({ ...time, isDirty: () => !saved,
    canSave: () => allowed, save: async () => { saved = true; } });
  controller.enable(); await time.fire();
  assert.equal(saved, false);
  allowed = true; await time.fire();
  assert.equal(saved, true);
  controller.dispose();
  assert.equal(time.timers.size, 0);
});
