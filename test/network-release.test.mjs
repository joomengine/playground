import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertHostedStagingEvidence } from '../scripts/network-release-evidence.mjs';

const commit = 'a'.repeat(40);
const run = { head_sha: commit, path: '.github/workflows/network-staging.yml', conclusion: 'success', event: 'workflow_dispatch' };
const jobs = [{ conclusion: 'success', steps: [{ name: 'Verify hosted candidate', conclusion: 'success' }] }];

test('production requires a successful hosted staging step for the identical source commit', () => {
  assertHostedStagingEvidence(run, jobs, commit);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { path: '.github/workflows/validate.yml' }, { event: 'pull_request' },
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: null }]) {
    assert.throws(() => assertHostedStagingEvidence({ ...run, ...change }, jobs, commit));
  }
  for (const state of ['skipped', 'failure', 'cancelled', undefined]) {
    assert.throws(() => assertHostedStagingEvidence(run, [{ conclusion: 'success', steps: [{ name: 'Verify hosted candidate', conclusion: state }] }], commit));
    assert.throws(() => assertHostedStagingEvidence(run, [{ ...jobs[0], conclusion: state }], commit));
  }
  assert.throws(() => assertHostedStagingEvidence(run, [], commit));
});

test('deployment credentials are restricted to explicit protected deployments and production Pages rejects staging builds', () => {
  const validation = readFileSync(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(validation, /secrets\.(?:CLOUDFLARE|TURNSTILE|SESSION|NETWORK_STAGING_TEST_SECRET)/);
  for (const environment of ['staging', 'production']) {
    const workflow = readFileSync(new URL(`../.github/workflows/network-${environment}.yml`, import.meta.url), 'utf8');
    assert.match(workflow, /^  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /pull_request_target|^  pull_request:/m);
    assert.match(workflow, new RegExp(`^    environment: network-${environment}$`, 'm'));
    assert.match(workflow, /^    needs: validate$/m);
    assert.doesNotMatch(workflow, /continue-on-error/);
  }
  const pages = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(pages, /assert\.equal\(manifest\.deployment\.environment, 'production'/);
  assert.match(pages, /assert\.equal\(health\.enabled, true\)/);
  const staging = readFileSync(new URL('../.github/workflows/network-staging.yml', import.meta.url), 'utf8');
  const credentialUse = staging.indexOf('NETWORK_STAGING_TEST_SECRET:');
  assert.ok(credentialUse > staging.indexOf('- name: Verify hosted candidate'));
  assert.ok(credentialUse < staging.indexOf('- name: Retain hosted staging evidence'));
  assert.equal(staging.match(/secrets\.NETWORK_STAGING_TEST_SECRET/g)?.length, 1);
  const hosted = readFileSync(new URL('./network-hosted.browser.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(hosted, /setExtraHTTPHeaders|addInitScript|ignoreHTTPSErrors|route\.fulfill/);
  assert.match(hosted, /route\.request\(\)\.url\(\) !== sessionURL \|\| route\.request\(\)\.method\(\) !== 'POST'/);
});
