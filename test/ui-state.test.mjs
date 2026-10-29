import assert from 'node:assert/strict';
import { test } from 'node:test';
import { customSetupDetails, defaultSiteKey, forgetSite, isolateSetup, publicConfiguration, readSavedState, rememberSite, runtimeLocation, savedStateKey } from '../src/ui-state.mjs';

const configuration = {
  deployId: 'jcb', joomlaVersion: '6.2.0', phpVersion: '8.4', siteName: 'Saved work',
  initialPath: '/administrator/', storageKey: 'work', language: 'en-GB', autoLogin: true,
  persistence: true, hideToolbar: false, fresh: true,
  extensions: [{ url: 'https://example.test/extension.zip', sha256: 'a'.repeat(64) }],
  startupCommands: [['cache:clean']],
  admin: { username: 'admin', password: 'private administrator password', email: 'private@example.test' },
  runtime: { internal: 'Do not save runtime state' },
};
const empty = () => readSavedState({ getItem() { return null; } }, 'settings');

test('custom deployment approval distinguishes commands with colliding display text', () => {
  const reviewed = { startupCommands: [['config:set', 'sitename', 'Demo Site']] };
  const changed = { startupCommands: [['config:set', 'sitename Demo', 'Site']] };
  assert.equal(reviewed.startupCommands[0].join(' '), changed.startupCommands[0].join(' '));
  const details = customSetupDetails(reviewed);
  assert.deepEqual(details.commands, reviewed.startupCommands);
  assert.notEqual(JSON.stringify(details), JSON.stringify(customSetupDetails(changed)),
    'Changing argument boundaries must require a new deployment approval.');
  assert.equal(JSON.stringify(details), JSON.stringify(customSetupDetails(structuredClone(reviewed))));
  details.commands[0].push('changed');
  assert.equal(reviewed.startupCommands[0].length, 3);
});

test('saved launch preferences whitelist public settings and consume fresh requests', () => {
  const value = publicConfiguration(configuration);
  assert.equal(value.deployId, 'jcb');
  assert.equal(value.fresh, false);
  assert.equal(Object.hasOwn(value, 'admin'), false);
  assert.equal(Object.hasOwn(value, 'runtime'), false);
  assert.doesNotMatch(JSON.stringify(value), /private administrator|private@example/);
  assert.deepEqual(value.startupCommands, [['cache:clean']]);
  value.startupCommands[0].push('extra');
  assert.deepEqual(configuration.startupCommands, [['cache:clean']]);
});

test('persistent sites remember the active key while reset preserves other sites', () => {
  const first = rememberSite(empty(), configuration);
  const both = rememberSite(first, { ...configuration, deployId: 'blank', storageKey: 'second' });
  assert.equal(both.active, 'second');
  assert.deepEqual(Object.keys(both.sites), ['work', 'second']);
  const restored = readSavedState({ getItem() { return JSON.stringify(both); } }, 'settings');
  assert.equal(restored.sites.work.phpVersion, '8.4');
  assert.equal(restored.sites.work.fresh, false);
  const reset = forgetSite(restored, 'second');
  assert.equal(reset.active, null);
  assert.deepEqual(Object.keys(reset.sites), ['work']);
});

test('temporary sites and malformed preference storage do not become resumable sites', () => {
  const state = empty();
  assert.equal(rememberSite(state, { ...configuration, persistence: false }), state);
  for (const value of ['{invalid', 'null', '{"schemaVersion":99,"sites":{}}', '{"schemaVersion":1,"active":"ghost","sites":{}}']) {
    const restored = readSavedState({ getItem() { return value; } }, 'settings');
    assert.equal(restored.active, null);
    assert.deepEqual(Object.keys(restored.sites), []);
  }
  assert.equal(readSavedState({ getItem() { throw new Error('Unavailable'); } }, 'settings').active, null);
});

test('generated keys separate Joomla releases and preference storage separates deployments', () => {
  assert.notEqual(defaultSiteKey('jcb', '5.4.10'), defaultSiteKey('jcb', '6.2.0'));
  assert.notEqual(defaultSiteKey('blank', '6.2.0'), defaultSiteKey('jcb', '6.2.0'));
  assert.match(defaultSiteKey('x'.repeat(90), '6.2.0'), /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
  assert.notEqual(defaultSiteKey('x'.repeat(90), '5.4.10'), defaultSiteKey('x'.repeat(90), '6.2.0'));
  assert.notEqual(savedStateKey('https://playground.joomengine.org/'), savedStateKey('https://playground.joomengine.org/nested/'));
});

test('location follows runtime choices, consumes fresh and keeps private setup out of new URLs', () => {
  const url = new URL(runtimeLocation('https://playground.joomengine.org/?php=8.3&fresh=1&start=0', configuration));
  assert.equal(url.searchParams.get('php'), '8.4');
  assert.equal(url.searchParams.get('key'), 'work');
  assert.equal(url.searchParams.has('fresh'), false);
  assert.equal(url.searchParams.get('start'), '0');
  assert.equal(url.searchParams.has('commands'), false);
  assert.equal(url.searchParams.has('extensions'), false);
  assert.doesNotMatch(url.href, /private|password|email/);
  const explicit = new URL(runtimeLocation('https://playground.joomengine.org/?commands=%5B%5B%22list%22%5D%5D&extension=https%3A%2F%2Fexample.test%2Fold.zip', configuration));
  assert.deepEqual(JSON.parse(explicit.searchParams.get('commands')), [['cache:clean']]);
  assert.deepEqual(JSON.parse(explicit.searchParams.get('extensions')), configuration.extensions);
  assert.equal(explicit.searchParams.has('extension'), false);
});

test('changed setup instructions create an independent stable site and preserve the original', async () => {
  const original = rememberSite(empty(), configuration);
  const input = { ...configuration, startupCommands: [['cache:clean'], ['config:set', 'offline', '1']] };
  const changed = await isolateSetup(original, input);
  assert.equal(changed.changed, true);
  assert.equal(changed.previousKey, configuration.storageKey);
  assert.notEqual(changed.configuration.storageKey, configuration.storageKey);
  assert.match(changed.configuration.storageKey, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
  assert.equal(input.storageKey, configuration.storageKey);
  const both = rememberSite(original, changed.configuration);
  assert.deepEqual(both.sites.work.startupCommands, configuration.startupCommands);
  assert.deepEqual(both.sites[changed.configuration.storageKey].startupCommands, input.startupCommands);
  assert.equal((await isolateSetup(both, input)).configuration.storageKey, changed.configuration.storageKey);
  assert.equal((await isolateSetup(both, changed.configuration)).changed, false);
  const changedExtension = await isolateSetup(original, { ...configuration, extensions: [] });
  assert.equal(changedExtension.changed, true);
  assert.notEqual(changedExtension.configuration.storageKey, changed.configuration.storageKey);
});

test('identical setup, PHP changes and new or temporary sites keep their requested identity', async () => {
  const state = rememberSite(empty(), configuration);
  for (const input of [
    structuredClone(configuration),
    { ...configuration, phpVersion: '8.3' },
    { ...configuration, storageKey: 'new-independent-site', startupCommands: [] },
    { ...configuration, persistence: false, startupCommands: [] },
  ]) {
    const result = await isolateSetup(state, input);
    assert.equal(result.changed, false);
    assert.equal(result.configuration.storageKey, input.storageKey);
  }
});


test('launch locations discard stale remote setup and refresh temporary public setup', async () => {
  const { createShareURL, readURLConfiguration } = await import('../src/config.mjs');
  const config = { deployId: 'blank', joomlaVersion: '6.2.0', phpVersion: '8.4', siteName: 'Current name',
    initialPath: '/', persistence: true, storageKey: 'current-site', autoLogin: true,
    menus: [{ title: 'Current home', component: 'com_content', view: 'featured', home: true }] };
  const persistent = new URL(runtimeLocation('https://example.test/?config=https://example.test/old.json&sha256=old&name=Old#deploy=stale', config));
  assert.equal(persistent.hash, '');
  assert.equal(persistent.searchParams.has('config'), false);
  assert.equal(persistent.searchParams.has('sha256'), false);
  assert.equal(persistent.searchParams.get('name'), 'Current name');
  assert.equal(persistent.searchParams.get('key'), 'current-site');
  const original = createShareURL('https://example.test/', { ...config, siteName: 'Old', persistence: false });
  const temporary = readURLConfiguration(runtimeLocation(original, { ...config, persistence: false }));
  assert.equal(temporary.config.siteName, 'Current name');
  assert.equal(temporary.config.menus[0].title, 'Current home');
  const privateChange = new URL(runtimeLocation(original, { ...config, persistence: false,
    template: { element: 'cassiopeia', params: { token: 'private' } } }));
  assert.equal(privateChange.hash, '');
  assert.equal(privateChange.href.includes('private'), false);
});
