import test from 'node:test';
import assert from 'node:assert/strict';
import { compatibleDynamicPhp, dynamicJoomlaChoices, matchingJcbChoices } from '../src/dynamic-selection.mjs';

const catalog = { defaults: { joomlaVersion: '6.2.0', phpVersion: '8.4' },
  php: [{ version: '8.3', patchVersion: '8.3.29' }, { version: '8.4', patchVersion: '8.4.1' }, { version: '8.5', patchVersion: '8.5.0' }],
  joomla: [{ version: '6.2.0', url: '/pinned.zip', sha256: 'a'.repeat(64), php: ['8.3', '8.4', '8.5'] }] };

test('nightly PHP choices intersect official minimum with shipped runtime binaries', () => {
  assert.deepEqual(compatibleDynamicPhp({ version: '7.0.0-alpha1-dev', phpMinimum: '8.4.0' }, catalog), ['8.4', '8.5']);
  assert.deepEqual(compatibleDynamicPhp({ version: '7.0.0-alpha1-dev', phpMinimum: '8.3.30' }, catalog), ['8.4', '8.5']);
  assert.deepEqual(compatibleDynamicPhp({ version: '7.0.0-alpha1-dev', phpMinimum: '8.6.0' }, catalog), []);
  assert.deepEqual(compatibleDynamicPhp({ version: '6.3.0-beta1' }, catalog), ['8.3', '8.4', '8.5']);
  assert.deepEqual(compatibleDynamicPhp({ version: '3.10.12' }, catalog), []);
});

test('refresh adds and removes discovered releases without replacing pinned or selected archives', () => {
  const nightly = { version: '7.0.0-alpha1-dev', url: 'https://developer.joomla.org/nightlies/current.zip', phpMinimum: '8.3.0' };
  const selected = new Map([[nightly.version, { url: nightly.url, sha256: 'b'.repeat(64), php: ['8.3', '8.4', '8.5'] }]]);
  const choices = dynamicJoomlaChoices(catalog, [{ version: '6.2.0', url: 'wrong' }, nightly], selected);
  assert.equal(choices[0].url, '/pinned.zip');
  assert.equal(choices[1].sha256, 'b'.repeat(64));
  assert.deepEqual(dynamicJoomlaChoices(catalog, [], selected).map(item => item.version), ['6.2.0', nightly.version]);
  assert.deepEqual(dynamicJoomlaChoices(catalog, []).map(item => item.version), ['6.2.0']);
  assert.equal(catalog.defaults.joomlaVersion, '6.2.0');
});

test('JCB choices match Joomla major and switch from 6 fallback when 7 is published', () => {
  const entries = [{ version: '5.5.0' }, { version: '6.2.0' }, { version: '6.3.0-beta1' }];
  const pinned = new Map([['6', { version: '6.2.0', package: { url: '/pinned-jcb.zip' } }]]);
  assert.deepEqual(matchingJcbChoices('5', entries, pinned).map(entry => entry.version), ['5.5.0']);
  assert.deepEqual(matchingJcbChoices('7', entries, pinned).map(entry => entry.version), ['6.2.0', '6.3.0-beta1']);
  assert.equal(matchingJcbChoices('6', entries, pinned)[0].package.url, '/pinned-jcb.zip');
  assert.deepEqual(matchingJcbChoices('7', [...entries, { version: '7.0.0-alpha1' }], pinned).map(entry => entry.version), ['7.0.0-alpha1']);
});
