import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ISOLATION_BOOTSTRAP_VERSION as version, isolationMarker, isolationNavigationURL, isolationResponseHeaders,
  ownedClientURL, runtimeResource, resolveRequestIsolation } from '../src/isolation.mjs';
import { DEFAULT_COMPATIBILITY_CONFIGURATION, nextIsolationAttempt, readBootstrapState, validateCompatibilityConfiguration } from '../src/isolation-bootstrap.mjs';
import { createShareURL } from '../src/config.mjs';
import { runtimeLocation } from '../src/ui-state.mjs';

const baseURL = 'https://playground.example/project/';
const initial = () => ({ version, attempted: [], takeover: false, phase: 'pending' });
const owner = (id, policy) => ({ id, type: 'window', frameType: 'top-level', url: isolationNavigationURL(baseURL, policy) });
const request = (url, clientId = '', extra = {}) => ({ request: new Request(url), clientId, ...extra });

test('shipping compatibility fallback is enabled independently of optional image delivery', async () => {
  const config = validateCompatibilityConfiguration(JSON.parse(await readFile(new URL('../config/browser-compatibility.json', import.meta.url), 'utf8')));
  assert.deepEqual(config, DEFAULT_COMPATIBILITY_CONFIGURATION);
  assert.equal(config.fallbackEnabled, true);
  const images = JSON.parse(await readFile(new URL('../config/public-assets-config.json', import.meta.url), 'utf8'));
  assert.equal(images.enabled, false);
  assert.equal(images.relayBaseURL, null);
});

test('bootstrap distinguishes takeover and one fallback and never reloads failed navigation in a loop', () => {
  const first = nextIsolationAttempt({ url: baseURL, state: initial(), verified: false, fallbackEnabled: true });
  assert.equal(first.reloadRequired, true);
  assert.equal(first.policy, 'credentialless');
  assert.equal(first.state.takeover, true);
  const removedMarker = nextIsolationAttempt({ url: baseURL, state: first.state, verified: false, fallbackEnabled: true });
  assert.match(removedMarker.error, /did not retain/);
  assert.equal(removedMarker.reloadRequired, undefined);
  const second = nextIsolationAttempt({ url: first.reloadURL, state: first.state, verified: false, failure: 'SAB missing', fallbackEnabled: true });
  assert.equal(second.policy, 'require-corp');
  assert.deepEqual(second.state.attempted, ['credentialless', 'require-corp']);
  const stopped = nextIsolationAttempt({ url: second.reloadURL, state: second.state, verified: false, failure: 'SAB missing', fallbackEnabled: true });
  assert.equal(stopped.reloadRequired, undefined);
  assert.match(stopped.error, /SAB missing/);
  assert.equal(stopped.state.phase, 'failed');
  const retried = nextIsolationAttempt({ url: first.reloadURL, state: stopped.state, verified: false, failure: 'SAB missing', fallbackEnabled: true });
  assert.match(retried.error, /No automatic reload was repeated/);
});

test('bootstrap succeeds only after actual verification and disabled fallback leaves normal mode intact', () => {
  const url = isolationNavigationURL(baseURL, 'credentialless');
  const normal = nextIsolationAttempt({ url, state: initial(), verified: true, fallbackEnabled: false });
  assert.equal(normal.mode, 'normal');
  assert.equal(normal.reloadRequired, false);
  const disabled = nextIsolationAttempt({ url, state: initial(), verified: false, fallbackEnabled: false, failure: 'not isolated', embedded: true });
  assert.match(disabled.error, /fallback is disabled/);
  assert.match(disabled.error, /parent page/);
  const enabledLater = nextIsolationAttempt({ url, state: disabled.state, verified: false, fallbackEnabled: true, failure: 'not isolated' });
  assert.equal(enabledLater.reloadRequired, true);
  assert.equal(enabledLater.policy, 'require-corp');
  const fallback = nextIsolationAttempt({ url: isolationNavigationURL(baseURL, 'require-corp'), state: initial(), verified: true, fallbackEnabled: true });
  assert.equal(fallback.mode, 'compatibility');
  assert.equal(fallback.state.phase, 'ready');
});

test('only validated current markers select startup policy and a new bootstrap version resets bounded state', () => {
  assert.equal(isolationMarker(`${baseURL}?__je_coep=${version}:invalid`), null);
  assert.equal(isolationMarker(`${baseURL}?__je_coep=${version}:require-corp&__je_coep=${version}:credentialless`), null);
  const old = JSON.stringify({ version: 'previous', attempted: ['credentialless', 'require-corp'], phase: 'failed' });
  assert.deepEqual(readBootstrapState({ getItem: () => old }, baseURL), initial());
  assert.throws(() => validateCompatibilityConfiguration({ schemaVersion: 1, fallbackEnabled: true, relayURL: 'https://arbitrary.example' }), /Invalid/);
});

test('two tabs, virtual sites, static nested workers and detached windows recover independent policies without a map', async () => {
  const clients = new Map([['normal', owner('normal', 'credentialless')], ['compatible', owner('compatible', 'require-corp')]]);
  const getClient = async id => clients.get(id);
  for (const [id, policy] of [['normal', 'credentialless'], ['compatible', 'require-corp']]) {
    const worker = ownedClientURL(`${baseURL}assets/db/src/worker.mjs`, { ownerId: id, baseURL });
    const nested = new URL('../vendor/engine/worker.mjs', worker).href;
    const detached = ownedClientURL(`${baseURL}src/database/window.html`, { ownerId: id, baseURL });
    clients.set(`${id}-worker`, { id: `${id}-worker`, type: 'worker', url: worker });
    clients.set(`${id}-window`, { id: `${id}-window`, type: 'window', frameType: 'top-level', url: detached });
    for (const event of [request(`${baseURL}__site/${id}/instance/index.php`), request(worker), request(nested),
      request(`${baseURL}config/public-assets.json`, `${id}-worker`), request('https://images.example/approved.png', `${id}-window`)]) {
      assert.deepEqual(await resolveRequestIsolation(event, { baseURL, getClient }), { ownerId: id, policy });
    }
    assert.equal(runtimeResource(nested, baseURL).url, `${baseURL}assets/db/vendor/engine/worker.mjs`);
  }
  // Simulate suspension/restart: resolve again using only live Clients data.
  assert.equal((await resolveRequestIsolation(request(`${baseURL}__site/compatible/i/index.php`), { baseURL, getClient })).policy, 'require-corp');
  clients.delete('compatible');
  await assert.rejects(resolveRequestIsolation(request(`${baseURL}__site/compatible/i/index.php`), { baseURL, getClient }), /owner tab is closed/);
});

test('invalid owners and runtime traversal cannot become an arbitrary static or network proxy', async () => {
  assert.throws(() => ownedClientURL('https://other.example/a.mjs', { ownerId: 'normal', baseURL }), /belong/);
  assert.throws(() => runtimeResource(`${baseURL}__runtime/normal/__site/x/y/index.php`, baseURL), /Invalid/);
  assert.throws(() => runtimeResource(`${baseURL}__runtime/normal/a%2fb`, baseURL), /Invalid/);
  assert.throws(() => runtimeResource(`${baseURL}__runtime/normal/a%5cb`, baseURL), /Invalid/);
  const unmarkedEmbed = { ...owner('nested', 'require-corp'), frameType: 'nested', url: baseURL };
  await assert.rejects(resolveRequestIsolation(request(`${baseURL}__runtime/nested/src/a.mjs`), { baseURL, getClient: async () => unmarkedEmbed }), /owner/);
});

test('marked embedded Playground retains its own policy but cannot promote a Joomla iframe to owner', async () => {
  const embedded = { ...owner('nested', 'require-corp'), frameType: 'nested' };
  assert.deepEqual(await resolveRequestIsolation(request(`${baseURL}__runtime/nested/src/a.mjs`), { baseURL, getClient: async () => embedded }),
    { ownerId: 'nested', policy: 'require-corp' });
  const siteFrame = { ...embedded, url: isolationNavigationURL(`${baseURL}__site/parent/site/`, 'require-corp') };
  await assert.rejects(resolveRequestIsolation(request(`${baseURL}__runtime/nested/src/a.mjs`), { baseURL, getClient: async () => siteFrame }), /owner/);
});

test('headers replace cached policy and private bootstrap markers stay out of portable deployment URLs', () => {
  const cached = isolationResponseHeaders({ 'Content-Type': 'image/png' }, 'require-corp');
  const normal = isolationResponseHeaders(cached, 'credentialless');
  assert.equal(normal.get('Cross-Origin-Embedder-Policy'), 'credentialless');
  assert.equal(normal.get('Cross-Origin-Opener-Policy'), 'same-origin');
  const current = isolationNavigationURL(`${baseURL}?config=https://example.com/deploy.json`, 'require-corp');
  const config = { persistence: false, siteName: 'Test', initialPath: '/', autoLogin: true, extensions: [], startupCommands: [] };
  assert.equal(isolationMarker(runtimeLocation(current, config)).policy, 'require-corp');
  assert.equal(isolationMarker(createShareURL(current, config)), null);
});
