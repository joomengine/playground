import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardVersion, metadata, registryEntry } from './npm-releases.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const groups = [
  { directory: '.', packages: ['fflate', 'postal-mime', 'esbuild', 'playwright'] },
  { directory: 'services/network-worker', packages: ['wrangler', 'miniflare'] },
];

export function updatePackagePins(manifest, lock, releases) {
  const next = structuredClone(manifest);
  for (const [name, release] of Object.entries(releases)) {
    const pins = name in (next.dependencies || {}) ? next.dependencies : next.devDependencies;
    assert.ok(pins && Object.hasOwn(pins, name), `Missing direct dependency ${name}`);
    const installed = lock.packages[`node_modules/${name}`];
    assert.equal(installed?.version, pins[name], `Inconsistent ${name} lock`);
    // Chromium 159 in Playwright 1.65.1 crashed the hosted UI and PHP runtime jobs on PR #29.
    if (name === 'playwright' && release.version === '1.65.1') continue;
    const version = forwardVersion(name, pins[name], release.version);
    if (version !== pins[name]) {
      assert.equal(release.license, installed.license, `Review licence change for ${name}`);
      pins[name] = version;
    }
  }
  return next;
}

async function updatePackages() {
  const changes = new Map();
  for (const { directory, packages } of groups) {
    const base = path.join(root, directory);
    const manifestFile = path.join(base, 'package.json');
    const lockFile = path.join(base, 'package-lock.json');
    const manifest = JSON.parse(await readFile(manifestFile));
    const lock = JSON.parse(await readFile(lockFile));
    const releases = Object.fromEntries(await Promise.all(packages.map(async name => [name, await metadata(registryEntry(name, 'latest'))])));
    const next = updatePackagePins(manifest, lock, releases);
    if (json(next) === json(manifest)) continue;
    const staged = await mkdtemp(path.join(os.tmpdir(), 'playground-npm-'));
    try {
      await writeFile(path.join(staged, 'package.json'), json(next));
      await copyFile(lockFile, path.join(staged, 'package-lock.json'));
      execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staged, stdio: 'inherit' });
      const resolved = JSON.parse(await readFile(path.join(staged, 'package-lock.json')));
      for (const [name, release] of Object.entries(releases)) {
        const pin = resolved.packages[`node_modules/${name}`];
        assert.equal(pin.version, next.dependencies?.[name] ?? next.devDependencies[name], `Lock version mismatch for ${name}`);
        if (pin.version === release.version) assert.equal(pin.integrity, release.dist.integrity, `Lock integrity mismatch for ${name}`);
      }
      changes.set(manifestFile, json(next));
      changes.set(lockFile, json(resolved));
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  for (const [file, bytes] of changes) await writeFile(file, bytes);
  console.log(changes.size ? 'Updated Playground npm manifests and lockfiles.' : 'No eligible Playground npm package updates.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await updatePackages();
