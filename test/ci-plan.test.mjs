import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validationPlan } from '../scripts/ci-plan.mjs';

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
