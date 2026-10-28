import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync, zipSync } from 'fflate';
import { downloadVerified, hashFile, inventory } from './assets.mjs';
import { applyJcbCompatibilityOverlay, JCB_SOURCE_OVERLAY } from './jcb-platform-overlay.mjs';
import { applyJcbVendorOverlay, JCB_VENDOR_OVERLAYS } from './jcb-vendor-overlay.mjs';
import { prepareJcbBanners } from './jcb-banners.mjs';
import { prepareJcbDashboardAssets } from './jcb-dashboard-assets.mjs';

const execute = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const COMPOSER = Object.freeze({ version: '2.10.3', url: 'https://getcomposer.org/download/2.10.3/composer.phar',
  sha256: '7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6' });
const SOURCES = new Map([
  ['261e11de61a31ce6183fdcdf35fd3fdc7d0ff93b347bfb4cdaf7d4c66f93385b', { version: '5.2.0', major: '5' }],
  ['17a2b4c7b352d0ead2592e7e5838ace8255bbcbdc71566d883e8e82ca3dacd8e', { version: '6.2.0', major: '6' }],
]);
const VENDOR = 'component-builder/libraries/phpspreadsheet/vendor/';
const protections = new Set(['.htaccess', 'htaccess.txt', 'index.html', 'web.config']);
const epoch = new Date(1980, 0, 1);

export const isReviewedJcbPackage = (sourceSha256) => SOURCES.has(sourceSha256);

export function deterministicZip(files) {
  return zipSync(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, bytes]) => [name, [bytes, { mtime: epoch }]])), { level: 9 });
}

export async function verifyJcbVendor(directory, expected) {
  assert.deepEqual(await inventory(directory), expected, 'The composed JCB vendor tree must exactly match its reviewed file inventory.');
}

async function composeVendor({ root, cache }) {
  const source = path.join(root, 'dependencies/jcb-spreadsheet');
  const inputNames = ['composer.json', 'composer.lock', 'packages.json', 'vendor-inventory.json'];
  const inputs = Object.fromEntries(await Promise.all(inputNames.map(async name => [name, await readFile(path.join(source, name))])));
  const hashes = Object.fromEntries(inputNames.map(name => [name, sha256(inputs[name])]));
  const key = sha256(JSON.stringify({ hashes, composer: COMPOSER }));
  const target = path.join(cache, 'jcb-vendor', key);
  const expected = JSON.parse(inputs['vendor-inventory.json']);
  const pins = JSON.parse(inputs['packages.json']);
  const lock = JSON.parse(inputs['composer.lock']);
  assert.equal(pins.schemaVersion, 1);
  assert.equal(pins.packages.length, lock.packages.length, 'Every Composer package requires an archive pin.');
  for (const dependency of lock.packages) {
    const pin = pins.packages.find(entry => entry.name === dependency.name);
    assert.ok(pin && pin.version === dependency.version && pin.url === dependency.dist.url
      && pin.source.reference === dependency.source.reference && /^[a-f0-9]{40}$/.test(dependency.dist.shasum),
    `The Composer package differs from its verified archive: ${dependency.name}`);
    assert.deepEqual(pin.source, dependency.source, `The dependency source differs for ${dependency.name}.`);
    assert.deepEqual(pin.license, dependency.license, `The dependency license declaration differs for ${dependency.name}.`);
  }
  let cached = false;
  try { cached = (await stat(path.join(target, 'vendor'))).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!cached) {
    const composer = await downloadVerified(COMPOSER.url, COMPOSER.sha256, path.join(cache, 'tools', `composer-${COMPOSER.version}.phar`));
    // Verify archive SHA-256 pins in addition to Composer's own archive checksums.
    await Promise.all(pins.packages.map(async (dependency) => {
      const archive = await downloadVerified(dependency.url, dependency.sha256, path.join(cache, 'jcb-dependency-archives', `${dependency.sha256}.zip`));
      const lockEntry = lock.packages.find(entry => entry.name === dependency.name);
      assert.equal(createHash('sha1').update(await readFile(archive)).digest('hex'), lockEntry.dist.shasum,
        `The Composer archive checksum differs for ${dependency.name}.`);
    }));
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'joomengine-jcb-vendor-'));
    try {
      for (const name of ['composer.json', 'composer.lock']) await writeFile(path.join(temporary, name), inputs[name]);
      console.log('Composing the locked JCB spreadsheet dependencies for 32-bit PHP…');
      const environment = { ...process.env, COMPOSER_ALLOW_SUPERUSER: '1', COMPOSER_ROOT_VERSION: '1.0.0',
        COMPOSER: path.join(temporary, 'composer.json'), COMPOSER_VENDOR_DIR: path.join(temporary, 'vendor'),
        COMPOSER_HOME: path.join(temporary, 'composer-home'), COMPOSER_CACHE_DIR: path.join(cache, 'composer') };
      delete environment.COMPOSER_AUTH;
      const { stdout, stderr } = await execute(process.env.PHP_BINARY || 'php', [composer, 'install', '--no-dev', '--prefer-dist',
        '--no-interaction', '--no-plugins', '--no-scripts', '--no-progress'], { cwd: temporary, env: environment, maxBuffer: 2 * 1024 * 1024 });
      if (stdout.trim()) console.log(stdout.trim());
      if (stderr.trim()) console.log(stderr.trim());
      await verifyJcbVendor(path.join(temporary, 'vendor'), expected);
      await mkdir(target, { recursive: true });
      await cp(path.join(temporary, 'vendor'), path.join(target, 'vendor'), { recursive: true });
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await verifyJcbVendor(path.join(target, 'vendor'), expected);
  const files = Object.fromEntries(await Promise.all(expected.map(async entry => [entry.path, new Uint8Array(await readFile(path.join(target, 'vendor', entry.path)))])));
  return { files: applyJcbVendorOverlay(files), inputs, hashes, packages: pins.packages, key };
}

/** Derive a compatible distribution from an exact official JCB package. */
export async function deriveJcbPackage({ root, cache, archive, sourceUrl, sourceSha256 }) {
  const source = SOURCES.get(sourceSha256);
  if (!source || await hashFile(archive) !== sourceSha256) throw new Error('The JCB package must match a reviewed upstream release.');
  const vendor = await composeVendor({ root, cache });
  const outer = unzipSync(new Uint8Array(await readFile(archive)));
  const componentPath = `pkg-component-builder-${source.version}/src/joomla__Component-Builder__${source.major}.x.zip`;
  if (!outer[componentPath]) throw new Error('The official JCB component archive is missing.');
  const banners = await prepareJcbBanners(applyJcbCompatibilityOverlay(unzipSync(outer[componentPath])), { root, cache, version: source.version });
  const dashboard = await prepareJcbDashboardAssets(banners.files, { root, version: source.version });
  const component = dashboard.files;
  for (const name of Object.keys(component)) {
    if (name.startsWith(VENDOR) && !protections.has(name.slice(VENDOR.length))) delete component[name];
  }
  for (const [name, bytes] of Object.entries(vendor.files)) component[`${VENDOR}${name}`] = bytes;
  for (const [name, bytes] of Object.entries(vendor.inputs)) {
    const filename = name === 'vendor-inventory.json' ? 'vendor-source-inventory.json' : name;
    component[`component-builder/libraries/phpspreadsheet/${filename}`] = bytes;
  }
  const vendorInventory = Object.entries(component).filter(([name]) => name.startsWith(VENDOR) && !name.endsWith('/'))
    .map(([name, bytes]) => ({ path: name.slice(VENDOR.length), size: bytes.byteLength, sha256: sha256(bytes) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const vendorInventoryBytes = new TextEncoder().encode(`${JSON.stringify(vendorInventory, null, 2)}\n`);
  component['component-builder/libraries/phpspreadsheet/vendor-inventory.json'] = vendorInventoryBytes;
  const provenance = {
    schemaVersion: 1, source: { url: sourceUrl, sha256: sourceSha256, version: source.version },
    target: { php: ['8.3', '8.4', '8.5'], integerBits: 32 }, composer: COMPOSER,
    dependencyInputs: vendor.hashes, dependencies: vendor.packages,
    sourceVendorInventory: { file: 'vendor-source-inventory.json', sha256: vendor.hashes['vendor-inventory.json'] },
    vendorInventory: { file: 'vendor-inventory.json', sha256: sha256(vendorInventoryBytes), files: vendorInventory.length },
    vendorOverlays: JCB_VENDOR_OVERLAYS.map(({ path, sha256, patchedSha256 }) => ({ path, sha256, patchedSha256 })),
    banners: banners.provenance,
    dashboard: dashboard.provenance,
    sourceOverlay: { path: JCB_SOURCE_OVERLAY.path, sha256: JCB_SOURCE_OVERLAY.sha256, patchedSha256: JCB_SOURCE_OVERLAY.patchedSha256 },
  };
  component['component-builder/libraries/phpspreadsheet/platform-provenance.json'] = new TextEncoder().encode(`${JSON.stringify(provenance, null, 2)}\n`);
  outer[componentPath] = deterministicZip(component);
  const bytes = deterministicZip(outer);
  const derivedSha256 = sha256(bytes);
  const destination = path.join(cache, 'jcb-derived', `${derivedSha256}.zip`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return { archive: destination, sha256: derivedSha256, provenance: { ...provenance, derived: { sha256: derivedSha256, size: bytes.byteLength } } };
}
