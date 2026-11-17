import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const validation = readFileSync(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
const publishing = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');

// Read the repository's job blocks without introducing a separate YAML runtime dependency.
function job(source, id) {
  const lines = source.split('\n');
  const start = lines.indexOf(`  ${id}:`);
  assert.ok(start >= 0, `The ${id} job must exist.`);
  const next = lines.findIndex((line, index) => index > start && /^  [\w-]+:$/.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

function aggregateScript() {
  const aggregate = job(validation, 'validate');
  const scripts = [...aggregate.matchAll(/^        run: \|\n((?:          .*\n?)+)/gm)];
  assert.equal(scripts.length, 1, 'The aggregate must have one executable result check.');
  return scripts[0][1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
}

test('live JCB checks wait for other validation and run browsers sequentially against the built distribution', () => {
  const gate = job(validation, 'jcb-network');
  assert.match(gate, /^    name: JCB API and repositories \(\$\{\{ matrix\.browser \}\}\)$/m);
  const needs = /^    needs: \[([^\n]+)\]$/m.exec(gate)?.[1].split(',').map(value => value.trim());
  const jobs = [...validation.slice(validation.indexOf('\njobs:\n')).matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]);
  const awaited = new Set(needs);
  const visit = id => {
    const value = /^    needs: (.+)$/m.exec(job(validation, id))?.[1];
    for (const dependency of (value?.replace(/^\[|\]$/g, '').split(',').map(value => value.trim()) ?? [])) {
      if (awaited.has(dependency)) continue;
      awaited.add(dependency); visit(dependency);
    }
  };
  for (const id of needs ?? []) visit(id);
  assert.deepEqual([...awaited].sort(), jobs.filter(id => !['jcb-network', 'validate'].includes(id)).sort(),
    'Live JCB requests must not overlap other validation jobs.');
  assert.match(gate, /^      max-parallel: 1$/m);
  assert.match(gate, /^      fail-fast: false$/m);
  assert.match(gate, /^        browser: \[chromium, firefox\]$/m);
  assert.match(gate, /^          name: playground-static$/m);
  assert.match(gate, /^          path: dist$/m);
  assert.match(gate, /^          PLAYGROUND_BROWSERS: \$\{\{ matrix\.browser \}\}$/m);
  assert.match(gate, /^        run: node scripts\/test-jcb-network\.mjs$/m);
  const condition = '${{ !cancelled() && ' + needs.map(id => `needs.${id}.result == 'success'`).join(' && ') + ' }}';
  assert.equal(/^    if: (.+)$/m.exec(gate)?.[1], condition,
    'The mandatory JCB gate must run after successful dependencies, including when an optional ancestor was skipped.');
  assert.doesNotMatch(gate, /continue-on-error|PLAYGROUND_(?:SCENARIOS|PHP_VERSIONS|JOOMLA_VERSIONS)/m,
    'The dedicated gate must not inherit optional scenario or version filters.');
  assert.match(gate, /name: Retain JCB network receipts and diagnostics\n        if: always\(\)/);
  assert.match(gate, /^          if-no-files-found: error$/m);
});

test('downstream release validation requires every direct prerequisite to succeed', () => {
  for (const id of ['browser', 'php-network', 'jcb-network', 'compatibility', 'version-catalog']) {
    const source = job(validation, id);
    const needs = /^    needs: \[([^\n]+)\]$/m.exec(source)?.[1].split(',').map(value => value.trim());
    assert.ok(needs?.length, `${id} must retain its direct prerequisites.`);
    const requirements = ["!cancelled()", ...needs.map(dependency => `needs.${dependency}.result == 'success'`)];
    if (['compatibility', 'version-catalog'].includes(id)) requirements.push("needs.checks.outputs.build == 'true'");
    assert.equal(/^    if: (.+)$/m.exec(source)?.[1], '${{ ' + requirements.join(' && ') + ' }}',
      `${id} must override the implicit ancestor success check while requiring every direct prerequisite to succeed.`);
  }
});

test('the aggregate fails for a failed, skipped, cancelled or absent required validation job', () => {
  const aggregate = job(validation, 'validate');
  assert.match(aggregate, /^    needs: \[[^\n]*\bjcb-network\b[^\n]*\]$/m);
  assert.match(aggregate, /^    if: always\(\)$/m);
  assert.match(aggregate, /^          JCB_NETWORK: \$\{\{ needs\.jcb-network\.result \}\}$/m);
  const script = aggregateScript();
  const baseline = { ...process.env, CHECKS: 'success', BUILD_REQUIRED: 'true', BUILD: 'success',
    BROWSERS: 'success', INTERACTIONS: 'success', COMPATIBILITY: 'success', VERSION_CATALOG: 'success', JCB_NETWORK: 'success', NETWORK_WORKER: 'success', PHP_NETWORK: 'success' };
  const run = env => spawnSync('bash', ['-e', '-c', script], { env: { ...baseline, ...env }, encoding: 'utf8' });
  assert.equal(run({}).status, 0, 'All successful jobs must permit the aggregate.');
  for (const gate of ['BUILD', 'BROWSERS', 'INTERACTIONS', 'COMPATIBILITY', 'VERSION_CATALOG']) {
    for (const result of ['failure', 'skipped', 'cancelled', '']) {
      assert.notEqual(run({ [gate]: result }).status, 0,
        `${gate}=${JSON.stringify(result)} must fail when the build is required.`);
    }
  }
  for (const gate of ['CHECKS', 'JCB_NETWORK', 'NETWORK_WORKER', 'PHP_NETWORK']) for (const result of ['failure', 'skipped', 'cancelled', '']) {
    for (const buildRequired of ['true', 'false']) {
      assert.notEqual(run({ [gate]: result, BUILD_REQUIRED: buildRequired }).status, 0,
        `${gate}=${JSON.stringify(result)} must fail even when BUILD_REQUIRED=${buildRequired}.`);
    }
  }
});

test('every pull-request update and main publication invokes the mandatory validation chain', () => {
  const triggers = validation.split('\njobs:')[0];
  assert.match(triggers, /^  pull_request:\s*$/m);
  assert.match(triggers, /^  workflow_call:\s*$/m);
  assert.doesNotMatch(triggers, /^\s+(?:types|paths|paths-ignore):/m,
    'Default pull_request events must include synchronize without changed-path exclusions.');
  const publications = publishing.split('\njobs:')[0];
  assert.match(publications, /^  push:\n    branches: \[main\]$/m);
  assert.match(publications, /^  schedule:\n    - cron:/m);
  assert.doesNotMatch(publications, /^\s+(?:paths|paths-ignore):/m);
  const publicationValidation = job(publishing, 'validate');
  assert.match(publicationValidation, /^    uses: \.\/\.github\/workflows\/validate\.yml$/m);
  assert.match(publicationValidation, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.doesNotMatch(publicationValidation, /needs:|configuration|continue-on-error/,
    'Configuration publication must still run the complete validation chain independently.');
  const deploy = job(publishing, 'deploy');
  assert.match(deploy, /^    needs: validate$/m);
  assert.doesNotMatch(deploy, /always\(\)|continue-on-error/);
  assert.doesNotMatch(publishing, /publish-configuration|pages-config-release|healthz/);
  assert.ok(deploy.indexOf('actions/download-artifact@') < deploy.indexOf('actions/deploy-pages@'));
  assert.ok(deploy.indexOf('actions/deploy-pages@') < deploy.indexOf('run: node scripts/pages-smoke.mjs dist'));
});
