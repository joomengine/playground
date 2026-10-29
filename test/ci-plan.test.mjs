import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeCacheKey, validationPlan } from '../scripts/ci-plan.mjs';
import pins from '../versions.json' with { type: 'json' };

test('documentation avoids native builds while presentation retains browser validation', () => {
  assert.deepEqual(validationPlan(['README.md', 'docs/rocket-implementation.md']), { build: false, full: false, scenarios: 'matrix,deploys,ui,rocket' });
  assert.deepEqual(validationPlan(['src/styles.css', 'src/locales/af.json']), { build: true, full: false, scenarios: 'matrix,deploys,ui,rocket' });
});

test('runtime, deployment and unknown changes always receive the complete matrix', () => {
  for (const name of ['src/php-worker.mjs', 'src/config.mjs', 'deploys/jcb.json', 'versions.json', '.github/workflows/validate.yml', 'new-runtime.mjs']) {
    assert.deepEqual(validationPlan([name]), { build: true, full: true, scenarios: '' }, name);
  }
  assert.deepEqual(validationPlan(['README.md'], { full: true }), { build: true, full: true, scenarios: '' });
});

test('native caches change with ABI inputs, while deployment and engine-only updates reuse them', () => {
  const key = nativeCacheKey(pins);
  const deployment = structuredClone(pins);
  deployment.defaults.phpVersion = '8.3';
  deployment.joomla[0].version = '5.4.99';
  deployment.bridge.version = '0.1.99';
  deployment.nativeDriver.sourceCommit = 'a'.repeat(40);
  assert.equal(nativeCacheKey(deployment), key);
  for (const change of [
    value => { value.upstream.emscripten = '7.0.0'; },
    value => { value.php[0].sourceSha256 = 'a'.repeat(64); },
    value => { value.nativeDriver.nativeSources['pdo_mariadb_wasm.c'] = 'a'.repeat(64); },
    value => { value.bridge.protocolVersion += 1; },
  ]) {
    const next = structuredClone(pins); change(next);
    assert.notEqual(nativeCacheKey(next), key);
  }
});
