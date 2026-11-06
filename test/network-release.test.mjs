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

const setupWorkflow = () => readFileSync(new URL('../.github/workflows/network-setup.yml', import.meta.url), 'utf8');

test('proxy setup is manual and waits for validation inside the protected production concurrency group', () => {
  const workflow = setupWorkflow();
  const trigger = /^on:\n((?:[ \t].*\n|\n)*)/m.exec(workflow)?.[1];
  assert.equal(trigger?.trim(), 'workflow_dispatch:', 'Setup must have only an explicit manual trigger.');
  const permissions = /^permissions:\n((?:[ \t].*\n|\n)*)/m.exec(workflow)?.[1];
  assert.equal(permissions?.trim(), 'contents: read');
  assert.equal(workflow.match(/^ *permissions:/gm)?.length, 1, 'Jobs cannot widen the read-only token permissions.');
  assert.match(workflow, /^concurrency:\n  group: network-production\n  cancel-in-progress: false$/m);
  assert.deepEqual([...workflow.slice(workflow.indexOf('\njobs:\n')).matchAll(/^  ([a-z][a-z0-9_-]*):$/gm)]
    .map(match => match[1]), ['validate', 'setup']);
  const validation = /^  validate:\n((?: {4}.*\n|\n)*)/m.exec(workflow)?.[1];
  assert.equal(validation?.trim(), 'uses: ./.github/workflows/validate.yml');
  assert.match(workflow, /^  setup:\n[\s\S]*?^    needs: validate$/m);
  assert.match(workflow, /^    environment: network-production$/m);
  assert.doesNotMatch(workflow, /^    if:|continue-on-error|secrets: inherit/m,
    'Setup cannot bypass a failed validation job or inherit deployment credentials.');
});

test('Cloudflare setup credentials exist only in the bootstrap step and account ID supports a repository variable or secret', () => {
  const workflow = setupWorkflow();
  const steps = workflow.split(/^      - /m).slice(1);
  const bootstrap = steps.filter(step => /^        run: node scripts\/network-setup\.mjs$/m.test(step));
  assert.equal(bootstrap.length, 1, 'Exactly one bootstrap command must run.');
  assert.match(bootstrap[0], /^        env:\n          CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}$/m);
  assert.match(bootstrap[0], /^          CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \|\| secrets\.CLOUDFLARE_ACCOUNT_ID \}\}$/m);
  assert.equal(workflow.match(/secrets\.CLOUDFLARE_API_TOKEN/g)?.length, 1);
  assert.equal(workflow.match(/secrets\.CLOUDFLARE_ACCOUNT_ID/g)?.length, 1);
  assert.doesNotMatch(steps.filter(step => step !== bootstrap[0]).join('\n'), /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|secrets\./);
  assert.match(workflow, /uses: actions\/checkout@[a-f0-9]{40}[^\n]*\n        with:\n          persist-credentials: false/);
  assert.match(workflow, /run: npm ci --ignore-scripts\n        working-directory: services\/network-worker/);
  assert.doesNotMatch(workflow, /secrets\.(?:TURNSTILE|SESSION|NETWORK_STAGING)|^    env:|^env:/m);
});

test('proxy setup retains only public settings and does not activate networking or publish a Pages build', () => {
  const workflow = setupWorkflow();
  const steps = workflow.split(/^      - /m).slice(1);
  const uploads = steps.filter(step => /uses: actions\/upload-artifact@/.test(step));
  assert.equal(uploads.length, 1);
  assert.match(uploads[0], /^          path: test-results\/network-setup\/$/m);
  assert.equal(uploads[0].match(/^          path:/gm)?.length, 1);
  assert.match(uploads[0], /^          if-no-files-found: error$/m);
  assert.doesNotMatch(uploads[0], /include-hidden-files: true|secrets\.|CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /wrangler deploy|npm run build|scripts\/build(?:-deploys)?\.mjs|deploy-pages@|upload-pages-artifact@|network-(?:staging|production)\.yml|git push|gh workflow run/);
  assert.deepEqual([...workflow.matchAll(/^        run: (.+)$/gm)].map(match => match[1]),
    ['npm ci --ignore-scripts', 'node scripts/network-setup.mjs']);
});
