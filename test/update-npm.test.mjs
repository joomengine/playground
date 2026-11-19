import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forwardVersion } from '../scripts/npm-releases.mjs';
import { updatePackagePins } from '../scripts/update-npm.mjs';

test('stable npm pins advance numerically and survive dist-tag rollbacks', () => {
  for (const [from, latest, wanted] of [['1.2.9', '1.2.10', '1.2.10'], ['1.12.0', '1.9.10', '1.12.0'], ['4.5.6', '5.0.0', '5.0.0']]) {
    assert.equal(forwardVersion('pkg', from, latest), wanted);
  }
  assert.throws(() => forwardVersion('pkg', '1.0.0', '2.0.0-beta.1'), /stable release/);
});

test('updates the direct package in place and preserves its licence for distribution', () => {
  const manifest = { dependencies: { runtime: '1.0.0' }, devDependencies: { tool: '2.0.0' } };
  const lock = { packages: { 'node_modules/tool': { version: '2.0.0', license: 'MIT' } } };
  const releases = { tool: { version: '2.1.0', license: 'MIT' } };
  assert.deepEqual(updatePackagePins(manifest, lock, releases), { dependencies: manifest.dependencies, devDependencies: { tool: '2.1.0' } });
  assert.deepEqual(updatePackagePins(manifest, lock, { tool: { version: '1.99.9' } }), manifest);
  assert.throws(() => updatePackagePins(manifest, lock, { tool: { version: '2.1.0', license: 'other' } }), /licence change/);
});

test('skips only the Playwright Chromium regression and admits its next stable release', () => {
  const manifest = { devDependencies: { playwright: '1.65.0', other: '1.65.0' } };
  const pin = { version: '1.65.0', license: 'Apache-2.0' };
  const lock = { packages: { 'node_modules/playwright': pin, 'node_modules/other': pin } };
  const blocked = { version: '1.65.1', license: pin.license };
  assert.deepEqual(updatePackagePins(manifest, lock, { playwright: blocked }), manifest);
  assert.deepEqual(updatePackagePins(manifest, lock, { playwright: blocked, other: blocked }).devDependencies,
    { playwright: '1.65.0', other: '1.65.1' });
  assert.equal(updatePackagePins(manifest, lock, { playwright: { ...blocked, version: '1.65.2' } }).devDependencies.playwright, '1.65.2');
});
