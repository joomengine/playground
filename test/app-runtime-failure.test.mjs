import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { resolveSiteURL } from '../src/config.mjs';
import { safeSavedRoute } from '../src/ui-state.mjs';

const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const launchSource = app.slice(app.indexOf('async function launch('), app.indexOf('async function closeSite('));

function fixture({ healthy = true, rejectClose = true } = {}) {
  const failure = new Error('Post-start view failed');
  const storageFailure = new DOMException('Browser storage is full', 'QuotaExceededError');
  const config = { storageKey: 'live-failure', deployId: 'blank', joomlaVersion: '6.2.0', phpVersion: '8.4',
    persistence: true, siteName: 'My live work', initialPath: '/administrator/', admin: { username: 'author' } };
  const calls = { mounted: [], diagnostics: [], feedback: [], close: 0, watch: 0, host: 0, discarded: 0, errors: [] };
  const handle = {
    healthy, configuration: config, baseUrl: 'https://playground.example/__site/owner/live/', installation: { administrator: config.admin },
    async close() { calls.close++; if (rejectClose) throw storageFailure; },
    async exportSite() { return { bytes: Uint8Array.of(1, 2, 3) }; },
  };
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: id !== 'welcome', value: '', textContent: '',
      checkValidity: () => true, removeAttribute() {}, focus() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $, URL, busy: false, launching: false, initialized: true, catalog: {}, deployCatalog: {},
    runtime: undefined, stoppedSite: undefined, currentSitePath: '/administrator/index.php?option=com_content',
    currentConfig: undefined, currentInput: undefined, backupPanel: null, savedState: { sites: {} },
    requireOwnerForReplacement: () => true, readLiveMetadata: () => null,
    launchCountdown: { stop() {} }, launchMedia: { setActive() {} },
    buildUpdates: { check: async () => false },
    formInput: () => config, dynamicMetadata: { joomla: [] }, freshKeyPending: false,
    isolateSetup: async (_, configuration) => ({ configuration, changed: false }),
    resolve: async configuration => ({ configuration }),
    fields: { storageKey: { value: config.storageKey } }, resumeLastRoute: false,
    createPlayground: async () => handle,
    show() {}, setDrawer() {}, openDialog() {}, clearFeedback() {}, progress() {},
    setBusy(value) { context.busy = value; }, t: key => key,
    renderJcbOptions() { throw failure; },
    destroyPreview() { calls.discarded++; }, mountPreview(url) { calls.mounted.push(url); },
    activity(error) { calls.diagnostics.push(error); }, feedback(error) { calls.feedback.push(error); },
    displayError(error) { calls.errors.push(error); },
    watchLivePersistence() { calls.watch++; }, hostRuntimeViews() { calls.host++; },
    safeSavedRoute, resolveSiteURL,
  });
  vm.runInContext(launchSource, context);
  return { context, calls, handle, failure, storageFailure };
}

test('a post-start UI error and rejected final save retain the healthy runtime for download or retry', async () => {
  const { context, calls, handle, failure, storageFailure } = fixture();
  assert.equal(await context.launch(), false);
  assert.equal(context.runtime, handle, 'The live worker handle must remain reachable.');
  assert.equal(context.runningSiteId, handle.configuration.storageKey);
  assert.equal(context.runningAdministrator, handle.installation.administrator);
  assert.deepEqual(calls.mounted, ['https://playground.example/__site/owner/live/administrator/index.php?option=com_content']);
  assert.equal(calls.diagnostics.at(-1), storageFailure);
  assert.deepEqual(calls.feedback, [failure]);
  assert.deepEqual(calls.errors, []);
  assert.equal(calls.watch, 1); assert.equal(calls.host, 1);
  assert.equal(context.busy, false); assert.equal(context.launching, false);
  assert.equal((await context.runtime.exportSite()).bytes.length, 3, 'Download remains available after browser storage rejects the close.');
});

test('an unhealthy worker is cleared after post-start failure instead of being shown as recoverable live memory', async () => {
  const { context, calls, failure } = fixture({ healthy: false });
  await context.launch();
  assert.equal(context.runtime, undefined);
  assert.deepEqual(calls.mounted, []);
  assert.deepEqual(calls.errors, [failure]);
  assert.equal(calls.close, 1);
});

test('successful cleanup after a post-start failure releases the runtime normally', async () => {
  const { context, calls, failure } = fixture({ rejectClose: false });
  await context.launch();
  assert.equal(context.runtime, undefined);
  assert.deepEqual(calls.mounted, []);
  assert.deepEqual(calls.errors, [failure]);
  assert.equal(calls.close, 1);
});
