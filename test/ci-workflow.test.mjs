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

test('JCB has a dedicated mandatory Chromium and Firefox job against the candidate build', () => {
  const gate = job(validation, 'jcb-network');
  assert.match(gate, /^    name: JCB API and repositories \(\$\{\{ matrix\.browser \}\}\)$/m);
  assert.match(gate, /^    needs: \[checks, build\]$/m);
  assert.match(gate, /^        browser: \[chromium, firefox\]$/m);
  assert.match(gate, /^          name: playground-static$/m);
  assert.match(gate, /^          path: dist$/m);
  assert.match(gate, /^          PLAYGROUND_BROWSERS: \$\{\{ matrix\.browser \}\}$/m);
  assert.match(gate, /^        run: node --test test\/jcb-network\.browser\.mjs$/m);
  assert.doesNotMatch(gate, /^    if:|continue-on-error|PLAYGROUND_(?:SCENARIOS|PHP_VERSIONS|JOOMLA_VERSIONS)/m,
    'The dedicated gate must not inherit optional scenario or version filters.');
  assert.match(gate, /name: Retain JCB network receipts and diagnostics\n        if: always\(\)/);
  assert.match(gate, /^          if-no-files-found: error$/m);
});

test('the aggregate fails for a failed, skipped, cancelled or absent JCB gate', () => {
  const aggregate = job(validation, 'validate');
  assert.match(aggregate, /^    needs: \[[^\n]*\bjcb-network\b[^\n]*\]$/m);
  assert.match(aggregate, /^    if: always\(\)$/m);
  assert.match(aggregate, /^          JCB_NETWORK: \$\{\{ needs\.jcb-network\.result \}\}$/m);
  const script = aggregateScript();
  const baseline = { ...process.env, CHECKS: 'success', BUILD_REQUIRED: 'true', BUILD: 'success',
    BROWSERS: 'success', INTERACTIONS: 'success', COMPATIBILITY: 'success', VERSION_CATALOG: 'success', JCB_NETWORK: 'success', NETWORK_WORKER: 'success', PHP_NETWORK: 'success' };
  const run = env => spawnSync('bash', ['-e', '-c', script], { env: { ...baseline, ...env }, encoding: 'utf8' });
  assert.equal(run({}).status, 0, 'All successful jobs must permit the aggregate.');
  for (const gate of ['JCB_NETWORK', 'NETWORK_WORKER', 'PHP_NETWORK']) for (const result of ['failure', 'skipped', 'cancelled', '']) {
    for (const buildRequired of ['true', 'false']) {
      assert.notEqual(run({ [gate]: result, BUILD_REQUIRED: buildRequired }).status, 0,
        `JCB=${JSON.stringify(result)} must fail even when BUILD_REQUIRED=${buildRequired}.`);
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
  assert.match(job(publishing, 'validate'), /^    uses: \.\/\.github\/workflows\/validate\.yml$/m);
  const deploy = job(publishing, 'deploy');
  assert.match(deploy, /^    needs: validate$/m);
  assert.doesNotMatch(deploy, /^    if:|continue-on-error/m,
    'Publishing must require successful mandatory validation.');
});
