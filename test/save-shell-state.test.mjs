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

test('staging a new site key uses its own save choice while saved keys still reopen their saved identity', () => {
  for (const optedIn of [false, true]) {
    let change, renders = 0;
    const opened = [];
    const fields = { persistence: { checked: true }, storageKey: {
      value: 'new-site', addEventListener(type, handler) { assert.equal(type, 'change'); change = handler; },
    } };
    const context = vm.createContext({
      fields, busy: false, persistenceForNewSite: optedIn, selectedSiteId: 'saved-site',
      savedState: { sites: { 'saved-site': { persistence: true } } },
      pauseAutomaticLaunch() {}, openSavedSite(key) { opened.push(key); },
      renderSavedSites() { renders++; }, setBusy(value) { context.busy = value; },
    });
    const start = "fields.storageKey.addEventListener('change', () => {";
    vm.runInContext(`${functionSource(start, '\n});')}\n});`, context);
    change();
    assert.equal(fields.persistence.checked, optedIn,
      'A new key must not inherit the previous saved site’s enabled persistence, but an explicit new-site choice is retained.');
    assert.equal(context.selectedSiteId, null);
    assert.equal(renders, 1);
    assert.deepEqual(opened, []);

    fields.storageKey.value = 'saved-site';
    change();
    assert.deepEqual(opened, ['saved-site'], 'Existing saved keys use the saved-site reopen flow.');
    assert.equal(renders, 1, 'The new-key branch must not run when reopening a saved key.');
  }
});

test('upload and checkpoint switches confirm replacing a temporary site without implicitly saving it', async () => {
  for (const importKind of ['siteExport', 'checkpoint']) {
    for (const confirmed of [false, true]) {
      const original = { configuration: { storageKey: 'temporary-source', persistence: false } };
      const imported = { storageKey: 'uploaded-site', persistence: false, restoredSite: true };
      const nodes = new Map(), calls = [];
      const stopAtCreate = new Error('Stop after verifying the runtime switch boundary');
      const context = vm.createContext({
        runtime: original, currentConfig: original.configuration, currentInput: original.configuration,
        busy: false, launching: false, initialized: true, catalog: {}, deployCatalog: {},
        freshKeyPending: false, resumeLastRoute: false, dynamicMetadata: { joomla: [] },
        launchCountdown: { stop() {} }, launchMedia: { setActive() {} }, buildUpdates: { check: async () => false },
        $(id) { if (!nodes.has(id)) nodes.set(id, { hidden: true, removeAttribute() {} }); return nodes.get(id); },
        setBusy(value) { context.busy = value; }, show() {}, clearFeedback() {}, activity() {},
        applyConfiguration() {}, destroyPreview() {}, feedback() {}, progress() {}, t: value => value,
        resolve: async configuration => ({ configuration }),
        confirm(message) { calls.push(['confirm', message]); return confirmed; },
        saveSite() { calls.push(['save']); throw new Error('Temporary replacement must not save implicitly.'); },
        async closeSite({ save }) { calls.push(['close', save]); context.runtime = undefined; return true; },
        async createPlayground(configuration) {
          calls.push(['create', configuration.storageKey, configuration.persistence]); throw stopAtCreate;
        },
        displayError(error) { assert.equal(error, stopAtCreate); },
      });
      vm.runInContext(functionSource('async function launch(', 'async function closeSite('), context);
      await context.launch({ [importKind]: {}, importedConfiguration: imported });
      assert.equal(context.busy, false);
      assert.equal(context.launching, false);
      if (confirmed) {
        assert.deepEqual(calls, [['confirm', 'confirm.temporary'], ['close', false], ['create', 'uploaded-site', false]],
          'Confirming a replacement closes the source without saving and starts the selected import.');
      } else {
        assert.deepEqual(calls, [['confirm', 'confirm.temporary']]);
        assert.equal(context.runtime, original, 'Canceling leaves the original runtime running.');
        assert.equal(context.currentConfig, original.configuration, 'Canceling leaves its temporary configuration unchanged.');
      }
    }
  }
});

test('upload configuration receives only the deliberately staged new-site save choice', async () => {
  for (const optedIn of [false, true]) {
    let upload, configuredChoice, launched;
    const file = {}, siteExport = {}, configuration = {};
    const context = vm.createContext({
      busy: false, launching: false, persistenceForNewSite: optedIn,
      fields: { persistence: { checked: true } }, catalog: {}, deploymentURL: 'https://example.test/',
      $(id) { assert.equal(id, 'upload-site-file'); return {
        addEventListener(type, handler) { assert.equal(type, 'change'); upload = handler; },
      }; },
      pauseAutomaticLaunch() {}, setBusy(value) { context.busy = value; }, administrator: () => ({}),
      async readSiteExport(value) { assert.equal(value, file); return siteExport; },
      configurationForSiteExport(value, catalog, options) {
        assert.equal(value, siteExport); configuredChoice = options.persistence; return configuration;
      },
      async launch(value) { launched = value; }, feedback(error) { throw error; },
    });
    vm.runInContext(functionSource("$('upload-site-file').addEventListener('change'", "$('export-button').addEventListener"), context);
    const target = { files: [file], value: 'site.zip' };
    await upload({ target });
    assert.equal(configuredChoice, optedIn, 'A saved source’s checked checkbox must not opt the uploaded site into saving.');
    assert.equal(launched.siteExport, siteExport);
    assert.equal(launched.importedConfiguration, configuration);
    assert.equal(context.busy, false);
    assert.equal(target.value, '');
  }
});

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
