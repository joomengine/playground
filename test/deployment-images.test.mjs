import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeploymentImageCache, deploymentImageFingerprint, maintainedDeploymentImages,
  completedDeploymentImageConfiguration, deploymentSnapshotSource, canCacheDeploymentImage } from '../src/deployment-images.mjs';

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

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('maintained downloads share only concurrent bytes and never persist installation archives', async () => {
  const storage = memoryStorage();
  const response = deferred();
  let downloads = 0;
  const cache = createDeploymentImageCache({ baseURL, storage,
    fetcher: async () => { downloads++; await response.promise; return new Response(bytes); } });
  const entry = cache.maintained(maintainedConfig, manifest);
  const first = cache.getMaintained(entry), second = cache.getMaintained(entry);
  response.resolve();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left.bytes, bytes);
  left.bytes.fill(0);
  assert.deepEqual(right.bytes, bytes, 'Each importer owns independent bytes.');
  assert.equal(downloads, 1);
  assert.equal(storage.writes, 0);
  assert.equal(storage.records.size, 0);
  assert.equal((await cache.getMaintained(entry)).cached, false);
  assert.equal(downloads, 2, 'A later fresh launch downloads the base again.');
});

test('fresh deployment downloads do not access failing browser archive storage', async () => {
  const cache = createDeploymentImageCache({ baseURL,
    storage: { get() { throw new Error('Quota storage must not be consulted'); }, put() { throw new Error('Quota storage must not be written'); } },
    fetcher: async () => new Response(bytes) });
  const warnings = [];
  assert.deepEqual((await cache.getMaintained(cache.maintained(maintainedConfig, manifest), { onWarning: warning => warnings.push(warning) })).bytes, bytes);
  assert.deepEqual(warnings, []);
});

test('maintained downloads reject corrupt bytes before returning to installation', async () => {
  const cache = createDeploymentImageCache({ baseURL, storage: memoryStorage(), fetcher: async () => new Response(Uint8Array.of(...bytes, 9)) });
  await assert.rejects(cache.getMaintained(cache.maintained(maintainedConfig, manifest)), /integrity/);
});

test('legacy archives remain visible for removal and reclamation never removes user custom images', async () => {
  const storage = memoryStorage();
  const entry = maintainedDeploymentImages(manifest, baseURL)[0];
  await storage.put(entry, bytes);
  await storage.put({ ...entry, key: 'custom:kept', kind: 'custom' }, bytes);
  const cache = createDeploymentImageCache({ baseURL, storage });
  assert.equal((await cache.list()).length, 2);
  assert.deepEqual(await cache.reclaimMaintained(), { removed: 1, bytes: bytes.length });
  assert.deepEqual((await cache.list()).map(record => record.key), ['custom:kept']);
  await cache.remove('custom:kept');
  assert.equal((await cache.list()).length, 0);
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

test('images saved after runtime metadata discovery match the next equivalent launch', async () => {
  const storage = memoryStorage();
  const cache = createDeploymentImageCache({ baseURL, storage });
  const launch = { ...config, overlays: [] };
  const installed = { ...launch, jcbVersion: 'none' };
  const before = await deploymentImageFingerprint(launch, manifest);
  await cache.saveCustom(installed, manifest, bytes);
  assert.deepEqual((await cache.getCustom(before))?.bytes, bytes,
    'Discovering that JCB is absent must not invalidate the image saved from this recipe.');
  assert.equal(await deploymentImageFingerprint(config, manifest), before,
    'An omitted overlay list and an empty overlay list describe the same setup.');
  assert.notEqual(await deploymentImageFingerprint({ ...installed, jcbVersion: '6.2.0' }, manifest), before,
    'A selected JCB release remains part of the image identity.');
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

test('maintained image catalog keeps package URLs and rejects conflicting identities', () => {
  assert.equal(maintainedDeploymentImages({ prebuiltDeploys: [{ ...manifest.prebuiltDeploys[0], url: 'https://elsewhere.test/image.zip' }] }, baseURL)[0].url, 'https://elsewhere.test/image.zip');
  assert.throws(() => maintainedDeploymentImages({ prebuiltDeploys: [manifest.prebuiltDeploys[0], manifest.prebuiltDeploys[0]] }, baseURL), /duplicate/);
});

test('private package downloads and record overlays never become reusable custom images', async () => {
  const storage = memoryStorage();
  const cache = createDeploymentImageCache({ baseURL, storage });
  assert.equal(canCacheDeploymentImage(config), true);
  const privatePackage = { ...config.extensions[0], authentication: { type: 'bearer', token: 'temporary-token' } };
  for (const change of [
    { extensions: [privatePackage] }, { jcbPackage: privatePackage }, { template: { ...privatePackage, element: 'custom' } },
    { extensions: [{ url: privatePackage.url, headers: { 'x-custom-key': 'temporary' } }] },
    { extensions: [{ url: `${privatePackage.url}?access_token=temporary` }] },
    { overlays: [{ key: 'settings', kind: 'component', component: 'com_example', fields: { params: { title: 'Agent' } } }] },
  ]) {
    const privateConfig = { ...config, ...change };
    assert.equal(canCacheDeploymentImage(privateConfig), false);
    assert.equal(await cache.saveCustom(privateConfig, manifest, bytes), null);
  }
  assert.equal(storage.writes, 0);
  assert.deepEqual(completedDeploymentImageConfiguration({ ...config, template: { ...privatePackage, element: 'custom' } }).template, { element: 'custom' });
});
