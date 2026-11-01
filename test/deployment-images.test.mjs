import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeploymentImageCache, deploymentImageFingerprint, maintainedDeploymentImages,
  completedDeploymentImageConfiguration, deploymentSnapshotSource } from '../src/deployment-images.mjs';

const baseURL = 'https://playground.example/project/';
const bytes = Uint8Array.of(0x50, 0x4b, 3, 4, 1, 2, 3, 4);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha256 = await hash(bytes);
const manifest = { sourceCommit: 'reviewed-build', php: [{ version: '8.4', patchVersion: '8.4.1',
  runtimeFingerprint: '1'.repeat(64), runtimeArchiveSha256: '2'.repeat(64) }],
  joomla: [{ version: '6.2.0', sha256: 'a'.repeat(64) }],
  prebuiltDeploys: [{ id: 'jcb', joomlaVersion: '6.2.0', phpVersion: '8.4',
    url: 'snapshots/prepared.zip', sha256, size: bytes.length }] };
const config = { deployId: 'custom-example', joomlaVersion: '6.2.0', phpVersion: '8.4', siteName: 'First site',
  admin: { name: 'First administrator', username: 'admin', email: 'first@example.test', password: 'private-password' },
  extensions: [{ url: 'https://example.test/package.zip', sha256: 'b'.repeat(64) }], startupCommands: [],
  deploymentRecipe: { name: 'My deployment' } };
const maintainedConfig = { deployId: 'jcb', joomlaVersion: '6.2.0', snapshot: {
  url: new URL('assets/snapshots/prepared.zip', baseURL).href, sha256, joomlaVersion: '6.2.0',
} };

function memoryStorage() {
  const records = new Map();
  return { records, writes: 0,
    async list() { return [...records.values()].map(({ blob, ...record }) => ({ ...record })); },
    async get(key) { return records.get(key); },
    async put(record, data) { this.writes++; records.set(record.key, { ...record, blob: new Blob([data]) }); },
    async touch(key, lastUsedAt) { if (records.has(key)) records.get(key).lastUsedAt = lastUsedAt; },
    async remove(key) { records.delete(key); },
  };
}

const settled = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('verified maintained images launch before cache writes finish and share immutable downloads while writing', { timeout: 2_000 }, async t => {
  const storage = memoryStorage();
  const write = deferred();
  t.after(() => write.resolve());
  const originalPut = storage.put.bind(storage);
  storage.put = async (record, blob) => { await write.promise; return originalPut(record, blob); };
  let downloads = 0;
  const cache = createDeploymentImageCache({ baseURL, storage, fetcher: async () => { downloads++; return new Response(bytes); } });
  const entry = maintainedDeploymentImages(manifest, baseURL)[0];
  const first = await cache.getMaintained(entry);
  assert.deepEqual(first.bytes, bytes);
  assert.equal(storage.records.size, 0, 'Installation starts without waiting for IndexedDB.');
  first.bytes.fill(0);
  structuredClone(first.bytes.buffer, { transfer: [first.bytes.buffer] });
  const second = await cache.getMaintained(entry);
  assert.deepEqual(second.bytes, bytes, 'A later caller receives verified bytes even if the importer detached its buffer.');
  second.bytes.fill(9);
  assert.deepEqual((await cache.getMaintained(entry)).bytes, bytes);
  assert.equal(downloads, 1, 'The verified download stays shared until its cache write settles.');
  write.resolve();
  await settled();
  const cached = await cache.getMaintained(entry);
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.bytes, bytes, 'Only the immutable verified snapshot reaches storage.');
  assert.equal(downloads, 1);
});

test('a delayed cache failure reports once without another launch phase, then a later launch can retry', { timeout: 2_000 }, async t => {
  const storage = memoryStorage();
  const write = deferred();
  t.after(() => write.resolve());
  const originalPut = storage.put.bind(storage);
  storage.put = () => write.promise;
  const warnings = [], progress = [];
  let downloads = 0;
  const cache = createDeploymentImageCache({ baseURL, storage, fetcher: async () => { downloads++; return new Response(bytes); } });
  const entry = maintainedDeploymentImages(manifest, baseURL)[0];
  const first = await cache.getMaintained(entry, { onWarning: message => warnings.push(message), onProgress: event => progress.push(event.phase) });
  assert.deepEqual(first.bytes, bytes);
  assert.deepEqual(warnings, []);
  assert.deepEqual((await cache.getMaintained(entry)).bytes, bytes);
  assert.equal(downloads, 1);
  write.reject(new Error('Quota exceeded'));
  await settled();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be saved locally/);
  assert.deepEqual(progress, ['download-image'], 'A completed launch never receives a late save/ready progress transition.');
  storage.put = originalPut;
  assert.deepEqual((await cache.getMaintained(entry)).bytes, bytes);
  await settled();
  assert.equal(downloads, 2);
  assert.equal(storage.records.size, 1);
});

test('optional last-used metadata never delays a verified cached image', { timeout: 2_000 }, async t => {
  const storage = memoryStorage();
  const touch = deferred();
  t.after(() => touch.resolve());
  const entry = maintainedDeploymentImages(manifest, baseURL)[0];
  await storage.put(entry, bytes);
  storage.touch = () => touch.promise;
  const warnings = [];
  const cache = createDeploymentImageCache({ baseURL, storage, fetcher: () => { throw new Error('No download is required'); } });
  assert.deepEqual((await cache.getMaintained(entry, { onWarning: message => warnings.push(message) })).bytes, bytes);
  touch.reject(new Error('Metadata storage unavailable'));
  await settled();
  assert.match(warnings[0], /cached image is available/);
  assert.equal(storage.records.size, 1);
});

test('maintained images reuse verified bytes and replace stale hashes before reuse', async () => {
  const storage = memoryStorage();
  let downloads = 0, served = bytes;
  const cache = createDeploymentImageCache({ baseURL, storage,
    fetcher: async () => { downloads++; return new Response(served); } });
  const entry = cache.maintained(maintainedConfig, manifest);
  const [first, concurrent] = await Promise.all([cache.getMaintained(entry), cache.getMaintained(entry)]);
  assert.deepEqual(first.bytes, bytes);
  assert.deepEqual(concurrent.bytes, bytes);
  assert.equal(downloads, 1);
  assert.equal((await cache.getMaintained(entry)).cached, true);
  assert.equal(storage.writes, 1, 'Reading updates metadata without rewriting the ZIP.');
  const list = await cache.list(manifest);
  assert.equal(list[0].available, true);
  assert.equal(list[0].size, bytes.length);
  assert.equal('url' in list[0], false);
  assert.equal('sha256' in list[0], false);
  assert.equal((await cache.list(undefined)).length, 1, 'Offline management retains cached images.');

  served = Uint8Array.of(...bytes, 9);
  const updated = { ...manifest, prebuiltDeploys: [{ ...manifest.prebuiltDeploys[0], sha256: await hash(served), size: served.length }] };
  assert.equal((await cache.list(updated))[0].available, false);
  assert.equal(storage.records.size, 0, 'Old server bytes are invalidated when the authoritative hash changes.');
  const latest = await cache.getMaintained(cache.maintained(maintainedConfig, updated));
  assert.deepEqual(latest.bytes, served);
  assert.equal(downloads, 2);
  await cache.remove(entry.key);
  assert.equal((await cache.list(updated))[0].available, false);
});

test('corruption is discarded, downloads require integrity, and quota failure does not block a valid image', async () => {
  const storage = memoryStorage();
  const entry = maintainedDeploymentImages(manifest, baseURL)[0];
  await storage.put(entry, Uint8Array.of(9, 9, 9));
  let downloads = 0;
  const cache = createDeploymentImageCache({ baseURL, storage, fetcher: async () => { downloads++; return new Response(bytes); } });
  assert.deepEqual((await cache.getMaintained(entry)).bytes, bytes);
  assert.equal(downloads, 1);
  await cache.remove(entry.key);
  const broken = createDeploymentImageCache({ baseURL, storage, fetcher: async () => new Response(Uint8Array.of(1)) });
  await assert.rejects(broken.getMaintained(entry), /integrity/);
  assert.equal(storage.records.size, 0);
  const warnings = [];
  storage.put = async () => { throw new Error('Quota exceeded'); };
  const result = await cache.getMaintained(entry, { onWarning: value => warnings.push(value) });
  assert.deepEqual(result.bytes, bytes);
  await settled();
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /https?:/);
});

test('custom images persist independently, expose no credentials, and survive server reconciliation', async () => {
  const storage = memoryStorage();
  const cache = createDeploymentImageCache({ baseURL, storage });
  const fingerprint = await deploymentImageFingerprint(config, manifest);
  const saved = await cache.saveCustom(config, manifest, bytes, { fingerprint });
  assert.equal(saved.title, 'My deployment');
  assert.deepEqual((await cache.getCustom(fingerprint)).bytes, bytes);
  assert.equal((await cache.list({ ...manifest, prebuiltDeploys: [] })).length, 1);
  assert.doesNotMatch(JSON.stringify(await cache.list()), /password|first@example|First administrator/);
  storage.records.get(saved.key).blob = new Blob([]);
  assert.equal(await cache.getCustom(fingerprint), null, 'An incomplete image is removed before it reaches the importer.');
  assert.equal(storage.records.size, 0);
});

test('fingerprints reuse ordinary site copies but isolate changed packages, runtimes and command identity', async () => {
  const original = await deploymentImageFingerprint(config, manifest);
  assert.equal(await deploymentImageFingerprint({ ...config, siteName: 'Second site', storageKey: 'second',
    admin: { ...config.admin, username: 'second', email: 'second@example.test', password: 'different-private-password' } }, manifest), original);
  for (const modified of [{ ...config, extensions: [{ ...config.extensions[0], sha256: 'c'.repeat(64) }] },
    { ...config, language: 'af-ZA' }, { ...config, content: { articles: [{ title: 'New content' }] } }]) {
    assert.notEqual(await deploymentImageFingerprint(modified, manifest), original);
  }
  assert.notEqual(await deploymentImageFingerprint(config, { ...manifest, php: [{ version: '8.4', patchVersion: '8.4.2' }] }), original);
  for (const field of ['runtimeFingerprint', 'runtimeArchiveSha256']) {
    assert.notEqual(await deploymentImageFingerprint(config, { ...manifest,
      php: [{ ...manifest.php[0], [field]: '3'.repeat(64) }] }), original,
    'A new runtime archive invalidates prepared images even when the PHP patch version is unchanged.');
  }
  const commands = { ...config, startupCommands: [['config:get', 'sitename']] };
  assert.notEqual(await deploymentImageFingerprint(commands, manifest),
    await deploymentImageFingerprint({ ...commands, siteName: 'Second site' }, manifest));
  const derived = { ...config, ...maintainedConfig };
  assert.notEqual(await deploymentImageFingerprint(derived, manifest, { baseURL }),
    await deploymentImageFingerprint(derived, { ...manifest, prebuiltDeploys: [{ ...manifest.prebuiltDeploys[0], sha256: 'd'.repeat(64) }] }, { baseURL }));
});

test('explicit snapshots cannot collide with blank images or a different maintained image', async () => {
  const plain = { ...config, deployId: 'jcb' };
  const explicit = { ...plain, snapshot: { url: 'https://example.test/export.zip', sha256: 'c'.repeat(64), joomlaVersion: '6.2.0' } };
  const original = await deploymentImageFingerprint(explicit, manifest, { baseURL });
  assert.notEqual(original, await deploymentImageFingerprint(plain, manifest, { baseURL }));
  for (const snapshot of [{ ...explicit.snapshot, sha256: 'd'.repeat(64) }, { ...explicit.snapshot, url: 'https://example.test/other.zip' }]) {
    assert.notEqual(original, await deploymentImageFingerprint({ ...explicit, snapshot }, manifest, { baseURL }));
  }
  const cache = createDeploymentImageCache({ baseURL, storage: memoryStorage() });
  assert.equal(cache.maintained(explicit, manifest), null, 'Matching deployment and Joomla IDs do not replace an explicitly selected image.');
  const changed = { ...manifest, prebuiltDeploys: [{ ...manifest.prebuiltDeploys[0], sha256: 'e'.repeat(64) }] };
  assert.equal(deploymentSnapshotSource(maintainedConfig, changed, baseURL).sha256, 'e'.repeat(64),
    'The current server hash is authoritative for a recognized maintained URL.');
  assert.equal(deploymentSnapshotSource(explicit, changed, baseURL).sha256, explicit.snapshot.sha256);
});

test('complete local images keep setup data while preventing package and command replay', () => {
  const source = { ...config, addonExtensions: config.extensions, addonStartupCommands: [['cache:clean']],
    addonLanguages: [{ tag: 'af-ZA' }], template: { element: 'cassiopeia', url: 'https://example.test/template.zip',
      sha256: 'a'.repeat(64), params: { brand: 'Keep' } } };
  const restored = completedDeploymentImageConfiguration(source);
  assert.deepEqual(restored.addonExtensions, []);
  assert.deepEqual(restored.addonStartupCommands, []);
  assert.deepEqual(restored.addonLanguages, []);
  assert.deepEqual(restored.template, { element: 'cassiopeia', params: { brand: 'Keep' } });
  assert.equal(restored.admin, source.admin, 'The receiving administrator still reaches snapshot import.');
  assert.equal(source.template.url, 'https://example.test/template.zip', 'The editable recipe remains intact.');
});

test('maintained image catalog rejects external URLs and conflicting identities', () => {
  assert.throws(() => maintainedDeploymentImages({ prebuiltDeploys: [{ ...manifest.prebuiltDeploys[0], url: 'https://elsewhere.test/image.zip' }] }, baseURL), /catalog is invalid/);
  assert.throws(() => maintainedDeploymentImages({ prebuiltDeploys: [manifest.prebuiltDeploys[0], manifest.prebuiltDeploys[0]] }, baseURL), /duplicate/);
});
