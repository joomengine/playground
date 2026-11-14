import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { readURLConfiguration } from '../src/config.mjs';
import { readRuntimeViewURL } from '../src/runtime-views.mjs';

const source = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
const initializeSource = source.slice(source.indexOf('async function initialize() {'), source.indexOf('\nasync function startInterface()'));
const base = 'https://example.test/playground/';
const liveSite = { deployId: 'jcb', joomlaVersion: '6.1.0', phpVersion: '8.4', storageKey: 'live', persistence: true, initialPath: '/' };
async function initialize({ url = base, saved = false, live = null, active = null, attachFailure = false } = {}) {
  const calls = { launch: [], attach: [], countdown: 0, errors: [] }, elements = new Map();
  const context = {
    URL, Map, Boolean, Object, setInterval() {},
    location: { href: url }, document: { hidden: false, documentElement: { dataset: {} } },
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    fields: { phpVersion: {}, deployId: {} }, deploymentURL: base,
    savedState: { active: saved ? 'live' : null, sites: saved ? { live: liveSite } : {} },
    preferences: {}, busy: false, launching: false, automaticLaunchPaused: false,
    catalogRefreshInterval: 300_000, companionRuntime: null,
    readURLConfiguration, readRuntimeViewURL, readActiveRuntimeView: () => active, readLiveMetadata: () => live,
    async connectRuntimeView(selection) { calls.attach.push(selection); if (attachFailure) throw new Error('Owner unavailable'); },
    launchCountdown: { start() { calls.countdown++; } },
    async launch(options) { calls.launch.push(options); },
    async initializeLocale() {}, getLocale: () => 'en-GB', async loadDeploymentDocument() { throw new Error('Unexpected document'); },
    setFocusMode() {}, activity() {}, async prepareEnvironment() { return {}; },
    buildUpdates: { async check() { return false; } }, password: () => 'initial-password', administrator: () => ({}),
    networkFetch: async () => ({ ok: true, async json() { return {}; } }),
    async loadDeployCatalog() { return { deploys: [] }; },
    parseCatalog: () => ({ defaults: { joomlaVersion: '6.1.0' }, php: [] }),
    async resolveDeployConfiguration() { return { deploy: {} }; },
    pinnedJcbPackages: () => new Map(), async refreshDynamicCatalog() {}, renderSavedSites() {}, fillJoomlaOptions() {}, fillOptions() {},
    pinnedJoomlaVersion: version => version, defaultSiteKey: () => 'default', findProfile: () => null,
    async resolve(input) { return { configuration: { ...liveSite, storageKey: 'default', ...input }, deploy: {} }; },
    applyConfiguration() {}, setBusy() {}, safeSavedRoute: (path, fallback) => path || fallback,
    t: key => key, displayError(error) { calls.errors.push(error.message); },
  };
  // Run the actual application initializer with isolated catalogs and UI effects.
  // Replacing launch and attach lets these tests prove which startup path wins.
  await runInNewContext(initializeSource.replaceAll('import.meta.url', JSON.stringify(`${base}src/app.mjs`)) + '\ninitialize();', context);
  return { calls, context };
}

test('first visit retains its launch countdown and does not immediately start workers', async () => {
  const { calls } = await initialize();
  assert.equal(calls.countdown, 1);
  assert.deepEqual(calls.launch, []);
  assert.deepEqual(calls.errors, []);
});

test('a saved live site resumes immediately and remains persistent despite an old opt-out URL', async () => {
  const { calls } = await initialize({ url: `${base}?key=live&persist=0`, saved: true });
  assert.equal(calls.countdown, 0);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].resumeOnly, true);
  assert.equal(calls.launch[0].importedConfiguration.persistence, true);
});

test('a stopped saved site stays stopped and retains the source backup and route', async () => {
  const { calls, context } = await initialize({ saved: true, live: { storageKey: 'live', stopped: true, sourceBackupId: 'backup-one', path: '/administrator/' } });
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.countdown, 0);
  assert.equal(context.stoppedSite.configuration.storageKey, 'live');
  assert.equal(context.stoppedSite.path, '/administrator/');
  assert.equal(context.sourceBackupId, 'backup-one');
});

test('an explicit companion URL can never fall through to a new deployment', async () => {
  const { calls } = await initialize({ url: `${base}?view=runtime_view_token_12345678`, attachFailure: true });
  assert.equal(calls.attach.length, 1);
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.countdown, 0);
  assert.deepEqual(calls.errors, ['Owner unavailable']);
});

test('another ordinary browser tab attaches to the active runtime before considering startup', async () => {
  const { calls } = await initialize({ saved: true, active: { token: 'runtime_view_token_12345678', storageKey: 'live', path: '/' } });
  assert.equal(calls.attach.length, 1);
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.countdown, 0);
});

test('a stale discovery marker can only resume the saved live site', async () => {
  const { calls } = await initialize({ saved: true, active: { token: 'runtime_view_token_12345678', storageKey: 'live', path: '/' }, attachFailure: true });
  assert.equal(calls.attach.length, 1);
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].resumeOnly, true);
  assert.equal(calls.countdown, 0);
  assert.deepEqual(calls.errors, []);
});

test('replacement entry points reject companion writers before creating or preparing a site', () => {
  for (const name of ['launch', 'recoverSite', 'useDeployment', 'applyDeployment']) {
    const declaration = source.indexOf(`async function ${name}(`);
    assert.ok(declaration >= 0, name);
    const guard = source.indexOf('if (!requireOwnerForReplacement()) return;', declaration);
    assert.ok(guard > declaration && guard < declaration + 350, `${name} must guard its entry before any runtime mutation`);
  }
});
