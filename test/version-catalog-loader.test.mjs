import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVersionCatalog, normalizeVersionCatalog, withoutCatalogPackages } from '../src/version-catalog.mjs';

const sha256 = 'a'.repeat(64), sha512 = 'b'.repeat(128);
const url = 'https://playground.example/project/assets/version-catalog.json';
const entry = { version: '7.0.0-alpha1-dev', url: `packages/${sha256}.zip`, sha256, phpMinimum: '8.3.0', channel: 'nightly', source: 'nightly' };
const document = () => ({ schemaVersion: 1, generatedAt: '2026-10-31T00:00:00.000Z', joomla: [{ ...entry }], jcb: [] });

test('the deployed version catalog resolves content-addressed packages under the deployment subpath', async () => {
  const requests = [];
  const result = await loadVersionCatalog({ url, fetchImpl: async (input, init) => {
    requests.push(input);
    assert.equal(init.cache, 'no-cache');
    return Response.json(document());
  } });
  assert.deepEqual(requests, [url]);
  assert.equal(result.joomla[0].url, `https://playground.example/project/assets/packages/${sha256}.zip`);
  assert.equal(result.joomla[0].phpMinimum, '8.3.0');
});

test('bad catalog versions, duplicate entries, remote URLs and mismatched content paths are rejected', () => {
  for (const bad of [
    { ...entry, version: '4.4.0' }, { ...entry, version: '8.0.0' },
    { ...entry, url: 'https://upstream.example/package.zip' },
    { ...entry, url: `../packages/${sha256}.zip` }, { ...entry, sha256: 'c'.repeat(64) },
    { ...entry, phpMinimum: 'unknown' }, { ...entry, channel: 'archive' }, { ...entry, sha512: 'bad' },
  ]) assert.throws(() => normalizeVersionCatalog({ ...document(), joomla: [bad] }, { url }));
  assert.throws(() => normalizeVersionCatalog({ ...document(), joomla: [entry, entry] }, { url }), /duplicate/);
  assert.throws(() => normalizeVersionCatalog({ ...document(), schemaVersion: 2 }, { url }), /invalid/);
});

test('unavailable or oversized catalogs fail without replacing the caller’s previous catalog', async () => {
  await assert.rejects(loadVersionCatalog({ url, fetchImpl: async () => new Response('', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(loadVersionCatalog({ url, fetchImpl: async () => new Response('{}', { headers: { 'Content-Length': 1024 * 1024 + 1 } }) }), /size limit/);
  await assert.rejects(loadVersionCatalog({ url, fetchImpl: async () => new Response(' '.repeat(1024 * 1024 + 1)) }), /size limit/);
});

test('only exact trusted package identities bypass custom setup review', () => {
  const joomla = { version: entry.version, url: 'https://playground.example/a.zip', sha256, php: ['8.4'] };
  const jcb = { version: '6.2.1-alpha1', url: 'https://playground.example/b.zip', sha256, sha512 };
  const input = { joomlaVersion: joomla.version, joomlaPackage: { url: joomla.url, sha256, php: ['8.4'] },
    jcbVersion: jcb.version, jcbPackage: { url: jcb.url, sha256, sha512 }, extensions: [{ url: 'https://custom.example/addon.zip' }], startupCommands: [['cache:clean']] };
  const catalog = { joomla: [joomla], jcb: [jcb] };
  const trusted = withoutCatalogPackages(input, catalog);
  assert.equal(trusted.joomlaPackage, undefined);
  assert.equal(trusted.jcbPackage, undefined);
  assert.deepEqual(trusted.extensions, input.extensions);
  assert.deepEqual(trusted.startupCommands, input.startupCommands);
  for (const changed of [{ url: 'https://custom.example/a.zip' }, { sha256: 'c'.repeat(64) }, { php: ['8.3'] }]) {
    const modified = { ...input, joomlaPackage: { ...input.joomlaPackage, ...changed } };
    assert.deepEqual(withoutCatalogPackages(modified, catalog).joomlaPackage, modified.joomlaPackage);
  }
  assert.ok(withoutCatalogPackages({ ...input, joomlaVersion: '6.2.0' }, catalog).joomlaPackage);
  assert.ok(withoutCatalogPackages({ ...input, jcbPackage: { ...input.jcbPackage, sha512: 'c'.repeat(128) } }, catalog).jcbPackage);
  assert.ok(input.joomlaPackage, 'The original configuration remains unchanged.');
});
