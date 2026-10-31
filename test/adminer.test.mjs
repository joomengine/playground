import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { installAdminer, withAdminerRequest } from '../src/database/runtime.mjs';

function memoryFS() {
  const files = new Map();
  return { files, mkdirTree() {}, writeFile(path, bytes) { files.set(path, bytes); }, analyzePath(path) { return { exists: files.has(path) }; } };
}

test('Adminer mounts atomically after verifying every asset and rejects corrupted downloads', async () => {
  const fs = memoryFS();
  const entries = ['adminer.php', 'index.php', 'bridge.js', 'adminer.css'].map(name => ({
    name, bytes: 2, sha256: createHash('sha256').update('ok').digest('hex'),
  }));
  const fetcher = async url => new Response(url.pathname.endsWith('manifest.json') ? JSON.stringify({ version: '6.2.0', files: entries })
    : url.pathname.endsWith('bridge.js') ? 'no' : 'ok');
  await assert.rejects(installAdminer({ fs, baseURL: 'https://playground.example/sub/', fetcher }), /integrity/);
  assert.equal(fs.files.size, 0, 'A corrupted bundle must not install a partially executable tool.');
});

test('private Adminer routing restores Joomla after failure and never exposes raw tool PHP', async () => {
  const fs = memoryFS(); fs.writeFile('/internal/adminer/index.php', 'entry');
  const php = { docroot: '/persist/www', prefix: '/sub/__site/owner/site/' };
  const options = { php, fs, sitePrefix: php.prefix, origin: 'https://playground.example' };
  await assert.rejects(withAdminerRequest({ ...options, request: { url: `${options.origin}${php.prefix}__adminer/?sql=` }, execute: async () => {
    assert.equal(php.docroot, '/internal/adminer');
    assert.equal(php.prefix, '/sub/__site/owner/site/__adminer/');
    throw new Error('query failed');
  } }), /query failed/);
  assert.equal(php.docroot, '/persist/www');
  assert.equal(php.prefix, '/sub/__site/owner/site/');
  const result = await withAdminerRequest({ ...options, request: { url: `${options.origin}${php.prefix}__adminer/adminer.php` }, execute: () => assert.fail('Raw PHP bypassed the wrapper.') });
  assert.equal(result.status, 404);
});
