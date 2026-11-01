import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadPhpRuntime } from './php-runtime.mjs';

/** Native ABI inputs exclude deploy choices and database engine-only releases. */
export function nativeCacheKey(pins) {
  return createHash('sha256').update(JSON.stringify({
    upstream: pins.upstream,
    php: pins.php.map(({ version, patchVersion, sourceCommit }) => ({ version, patchVersion, sourceCommit })),
    runtime: pins.runtime?.archives?.map(({ minor, sha256, fingerprint }) => ({ minor, sha256, fingerprint })),
    protocol: pins.bridge.protocolVersion, sources: pins.nativeDriver.nativeSources,
  })).digest('hex');
}

/** Unknown paths receive the full matrix; only presentation-only edits narrow it. */
export function validationPlan(paths, { full = false } = {}) {
  const documentation = (name) => /^(?:README\.md|NOTICE|LICENSE|docs\/.*|deploys\/README\.md)$/.test(name);
  const presentation = (name) => /^(?:index\.html|src\/(?:app\.mjs|styles\.css|i18n\.mjs|frame-view\.mjs|locales\/.*|brand\/.*))$/.test(name);
  const changed = [...new Set(paths)].filter(Boolean);
  const build = full || changed.some((name) => !documentation(name));
  const matrix = full || changed.some((name) => !documentation(name) && !presentation(name));
  return { build, full: matrix, scenarios: matrix ? '' : 'matrix,deploys,ui,rocket' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configured = JSON.parse(readFileSync(new URL('../versions.json', import.meta.url)));
  let output;
  let paths = [];
  if (process.argv.includes('--native')) {
    const pins = await loadPhpRuntime({ versions: configured });
    output = { native: nativeCacheKey(pins), compiler_image: pins.upstream.emscriptenImage };
  } else {
    const forced = process.env.CI_FULL === 'true';
    const base = process.env.CI_BASE_SHA;
    if (!forced && !/^[a-f0-9]{40}$/.test(base || '')) throw new Error('A full commit SHA is required to select pull-request checks.');
    paths = forced ? [] : execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' }).trim().split('\n');
    const plan = validationPlan(paths, { full: forced });
    if (!/^[a-f0-9]{40}$/.test(configured.nativeDriver.sourceCommit)) throw new Error('Native sources must use an immutable commit SHA.');
    output = {
      build: String(plan.build), full: String(plan.full), scenarios: plan.scenarios,
      php: plan.full ? '' : configured.defaults.phpVersion,
      joomla: plan.full ? '' : configured.defaults.joomlaVersion,
      bridge: configured.nativeDriver.sourceCommit,
    };
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify({ changed: paths, ...output }, null, 2));
}
