import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRefreshController } from '../src/code/refresh.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let next = 0;
  const timers = new Map();
  return {
    setTimer: callback => { timers.set(++next, callback); return next; },
    clearTimer: id => timers.delete(id),
    get size() { return timers.size; },
    async tick() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('manual is default: successful writes mark changed but do not refresh or save buffers', async () => {
  let reloads = 0;
  const time = clock();
  const controller = createRefreshController({ refresh: () => { reloads++; }, ...time });
  assert.equal(controller.state.automatic, false);
  await controller.trackSave(Promise.resolve('written'));
  assert.equal(reloads, 0);
  assert.equal(time.size, 0);
  assert.equal(controller.state.savedChanges, true);
  await controller.refresh();
  assert.equal(reloads, 1);
  assert.equal(controller.state.savedChanges, false);
  controller.dispose();
});

test('manual refresh waits for all in-flight saves and coalesces simultaneous refresh requests', async () => {
  let reloads = 0;
  const controller = createRefreshController({ refresh: () => { reloads++; } });
  const first = deferred(), second = deferred();
  const save1 = controller.trackSave(first.promise);
  const refresh = controller.refresh();
  assert.equal(controller.refresh(), refresh);
  const save2 = controller.trackSave(second.promise);
  first.resolve(); await save1;
  assert.equal(reloads, 0);
  second.resolve(); await save2; await refresh;
  assert.equal(reloads, 1);
  assert.equal(controller.state.savedChanges, false);
  controller.dispose();
});

test('automatic refresh is once after completed adjacent successful save batches', async () => {
  let reloads = 0;
  const time = clock();
  const controller = createRefreshController({ refresh: () => { reloads++; }, ...time });
  controller.setAutomatic(true);
  await controller.trackSave(Promise.resolve());
  await controller.trackSave(Promise.resolve());
  assert.equal(time.size, 1);
  await time.tick();
  assert.equal(reloads, 1);
  assert.equal(controller.state.savedChanges, false);
  controller.dispose();
});

test('failed saves prevent refresh and never falsely clear saved-change status', async () => {
  let reloads = 0;
  const time = clock();
  const controller = createRefreshController({ refresh: () => { reloads++; }, ...time });
  controller.setAutomatic(true);
  const write = deferred();
  const saving = controller.trackSave(write.promise);
  const refresh = controller.refresh();
  write.reject(new Error('Disk full'));
  await assert.rejects(saving, /Disk full/);
  await assert.rejects(refresh, /Disk full/);
  await time.tick();
  assert.equal(reloads, 0);
  assert.equal(controller.state.savedChanges, false);
  controller.dispose();
});

test('a paused request suppresses automatic and explicit refresh without stopping editing', async () => {
  let reloads = 0;
  const time = clock();
  const controller = createRefreshController({ refresh: () => { reloads++; }, ...time });
  controller.setAutomatic(true);
  await controller.trackSave(Promise.resolve());
  controller.setPaused(true);
  assert.equal(time.size, 0);
  await assert.rejects(controller.refresh(), /paused PHP request/);
  assert.equal(controller.state.savedChanges, true);
  controller.setPaused(false);
  await time.tick();
  assert.equal(reloads, 1);
  controller.dispose();
});

test('pausing during an in-flight save stops a pending manual refresh', async () => {
  let reloads = 0;
  const controller = createRefreshController({ refresh: () => { reloads++; } });
  const write = deferred();
  const saving = controller.trackSave(write.promise);
  const refresh = controller.refresh();
  controller.setPaused(true);
  write.resolve(); await saving;
  await assert.rejects(refresh, /paused PHP request/);
  assert.equal(reloads, 0);
  controller.dispose();
});

test('writes completed during a reload remain marked changed and schedule one subsequent reload', async () => {
  const firstReload = deferred();
  let reloads = 0;
  const time = clock();
  const controller = createRefreshController({ refresh: () => { reloads++; return reloads === 1 ? firstReload.promise : undefined; }, ...time });
  controller.setAutomatic(true);
  await controller.trackSave(Promise.resolve());
  const refreshing = controller.refresh();
  await Promise.resolve();
  await controller.trackSave(Promise.resolve());
  firstReload.resolve(); await refreshing;
  assert.equal(controller.state.savedChanges, true);
  await time.tick();
  assert.equal(reloads, 2);
  assert.equal(controller.state.savedChanges, false);
  controller.dispose();
});

test('no-op writes and disposal do not schedule new refreshes', async () => {
  const time = clock();
  const controller = createRefreshController({ refresh: () => { throw new Error('unexpected'); }, ...time });
  controller.setAutomatic(true);
  await controller.trackSave(Promise.resolve(), { changed: false });
  assert.equal(controller.state.savedChanges, false);
  assert.equal(time.size, 0);
  controller.markSaved();
  assert.equal(time.size, 1);
  controller.dispose();
  assert.equal(time.size, 0);
  assert.throws(() => controller.markSaved(), /closed/);
});

test('failed automatic refresh reports once and does not enter a retry loop', async () => {
  const time = clock();
  let reloads = 0, errors = 0;
  const controller = createRefreshController({ refresh: () => { reloads++; throw new Error('Preview unavailable'); }, onError: () => { errors++; }, ...time });
  controller.setAutomatic(true);
  await controller.trackSave(Promise.resolve());
  await time.tick();
  assert.equal(reloads, 1);
  assert.equal(errors, 1);
  assert.equal(time.size, 0);
  assert.equal(controller.state.savedChanges, true);
  controller.dispose();
});

test('one failing concurrent write suppresses automatic reload of the mixed result', async () => {
  const time = clock();
  let reloads = 0;
  const controller = createRefreshController({ refresh: () => { reloads++; }, ...time });
  controller.setAutomatic(true);
  const good = deferred(), bad = deferred();
  const saved = controller.trackSave(good.promise);
  const failed = controller.trackSave(bad.promise);
  bad.reject(new Error('Conflict'));
  await assert.rejects(failed, /Conflict/);
  good.resolve(); await saved;
  await time.tick();
  assert.equal(reloads, 0);
  assert.equal(controller.state.savedChanges, true);
  controller.dispose();
});

test('partial successful writes remain visible without automatically refreshing a failed batch', async () => {
  const time = clock();
  let reloads = 0;
  const controller = createRefreshController({ refresh: () => { reloads++; }, ...time });
  controller.setAutomatic(true);
  controller.markSaved({ automatic: false });
  assert.equal(controller.state.savedChanges, true);
  await time.tick();
  assert.equal(reloads, 0);
  await controller.refresh();
  assert.equal(reloads, 1);
  controller.dispose();
});
