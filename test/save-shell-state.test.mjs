import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { forgetSite } from '../src/ui-state.mjs';

const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
function functionSource(start, end) {
  const offset = source.indexOf(start);
  assert.notEqual(offset, -1);
  const finish = source.indexOf(end, offset + start.length);
  assert.notEqual(finish, -1);
  return source.slice(offset, finish);
}

function closeFixture(failure) {
  let writes = 0, redundantClose = 0;
  const handle = { healthy: false, debugger: { state: 'idle' },
    reset: async () => { throw failure; }, close: async () => { redundantClose++; } };
  const context = vm.createContext({
    runtime: handle, busy: false, closing: false, openingCode: false, openingDatabase: false,
    previewDirty: false, codeHost: undefined, databaseHost: undefined, savingSite: undefined,
    currentConfig: { storageKey: 'reset-me', persistence: true }, selectedSiteId: 'reset-me',
    runningSiteId: 'reset-me', runningAdministrator: {}, pendingFresh: true, freshKeyPending: true,
    savedState: { schemaVersion: 3, active: 'reset-me', sites: {
      'reset-me': { storageKey: 'reset-me' }, retained: { storageKey: 'retained' },
    } },
    forgetSite, writePreferences() { writes++; },
    setBusy(value) { context.busy = value; }, destroyPreview() {}, displayError() {}, activity() {},
    feedback() {}, t: value => value,
  });
  vm.runInContext(functionSource('async function closeSite(', 'async function openSavedSite('), context);
  return { context, get writes() { return writes; }, get redundantClose() { return redundantClose; } };
}

test('completed reset removes only its erased saved-site entry after a later cleanup failure', async () => {
  const failure = Object.assign(new Error('Lock release failed after deletion'), { closed: true, erased: true });
  const fixture = closeFixture(failure);
  assert.equal(await fixture.context.closeSite({ reset: true }), false, 'Cleanup failure remains visible.');
  assert.equal(fixture.context.runtime, undefined);
  assert.equal(Object.hasOwn(fixture.context.savedState.sites, 'reset-me'), false);
  assert.equal(Object.hasOwn(fixture.context.savedState.sites, 'retained'), true);
  assert.equal(fixture.context.savedState.active, null);
  assert.equal(fixture.context.selectedSiteId, null);
  assert.equal(fixture.writes, 1);
  assert.equal(fixture.redundantClose, 0, 'An already closed worker is never closed again.');
});

test('failed reset preserves its saved-site entry when storage was not erased', async () => {
  const fixture = closeFixture(Object.assign(new Error('Deletion blocked'), { closed: true, erased: false }));
  await fixture.context.closeSite({ reset: true });
  assert.equal(fixture.context.runtime, undefined);
  assert.equal(Object.hasOwn(fixture.context.savedState.sites, 'reset-me'), true);
  assert.equal(fixture.writes, 0);
  assert.equal(fixture.redundantClose, 0);
});

test('a completed save refreshes saved-site controls after publishing its receipt without unlocking a close', async () => {
  for (const closingSave of [false, true]) {
    const calls = [], nodes = new Map();
    const runtime = { configuration: { persistence: true, storageKey: 'first-save' },
      lastSavedAt: '2026-11-13T21:00:00.000Z', healthy: true, flush: async () => {} };
    const context = vm.createContext({
      runtime, busy: closingSave, launching: false, savePromise: undefined, savingSite: undefined,
      currentConfig: runtime.configuration, currentInput: runtime.configuration,
      fields: { storageKey: { value: 'first-save' } }, persistenceChoiceVersion: 0, persistenceForNewSite: true,
      saveFailed: false, lastSavedAt: undefined, databaseHost: undefined, autosave: { saved() {} },
      $(id) { if (!nodes.has(id)) nodes.set(id, { disabled: false, open: false }); return nodes.get(id); },
      updateSaveState() {}, updateRuntimeLocation() {},
      rememberCurrentSite({ savedAt }) { calls.push(['catalogue', savedAt]); return true; },
      setBusy(value) { calls.push(['controls', value, context.savePromise]); },
      activity() {}, feedback() {}, messageOf: String, t: value => value, Date,
    });
    vm.runInContext(functionSource('function saveSite(', 'function showShare('), context);
    assert.equal(await context.saveSite({ quiet: true, closingSave }), true);
    assert.deepEqual(calls, [['catalogue', runtime.lastSavedAt], ['controls', closingSave, undefined]],
      'Controls refresh after the new catalogue entry and cleared save promise, preserving an active close lock.');
  }
});
