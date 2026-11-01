import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { phpRuntimeAssetPath } from '../scripts/build-identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = digest('verified PHP release archive');
const emitted = (file, bytes) => ({ file, sha256: digest(bytes) });
const overlays = () => ({
  'php-cgi-wasm': { files: [emitted('breakoutRequest.mjs', 'binary request decoder'), emitted('PhpCgiBase.mjs', 'bounded stdin')] },
  'php-dbg-wasm': { files: [emitted('php8.3-dbg-web.mjs', 'dedicated worker loader')] },
});

test('changed emitted CGI or debugger bytes cannot reuse the cached PHP module graph from the same release', () => {
  const original = overlays();
  const originalPath = phpRuntimeAssetPath('8.3', archive, original);
  const cgiChanged = structuredClone(original);
  cgiChanged['php-cgi-wasm'].files[0] = emitted('breakoutRequest.mjs', 'corrected binary request decoder');
  const debugChanged = structuredClone(original);
  debugChanged['php-dbg-wasm'].files[0] = emitted('php8.3-dbg-web.mjs', 'corrected dedicated worker loader');
  const paths = [originalPath, phpRuntimeAssetPath('8.3', archive, cgiChanged), phpRuntimeAssetPath('8.3', archive, debugChanged)];
  assert.equal(new Set(paths).size, 3);
  const moduleURLs = paths.map(base => new URL(`${base}/php-cgi-wasm/PhpCgiWorker.mjs`, 'https://example.test/playground/assets/'));
  const decoderURLs = moduleURLs.map(url => new URL('breakoutRequest.mjs', url).href);
  assert.equal(new Set(decoderURLs).size, 3, 'Relative imports also receive distinct HTTP cache keys.');
  assert.ok(paths.every(value => /^php\/8\.3\/[a-f0-9]{64}$/.test(value)));
});

test('identical output bytes retain their URLs despite helper metadata or enumeration order changes', () => {
  const original = overlays();
  const reordered = Object.fromEntries(Object.entries(original).reverse().map(([name, overlay]) => [name,
    { ...overlay, buildScriptSha256: digest('refactored build helper'), files: [...overlay.files].reverse() }]));
  assert.equal(phpRuntimeAssetPath('8.3', archive, reordered), phpRuntimeAssetPath('8.3', archive, original));
  assert.notEqual(phpRuntimeAssetPath('8.3', digest('new release'), original), phpRuntimeAssetPath('8.3', archive, original));
  assert.notEqual(phpRuntimeAssetPath('8.4', archive, original), phpRuntimeAssetPath('8.3', archive, original));
});

test('a missing output checksum cannot silently retain the old runtime cache identity', () => {
  const incomplete = overlays();
  delete incomplete['php-dbg-wasm'].files[0].sha256;
  assert.throws(() => phpRuntimeAssetPath('8.3', archive, incomplete), /Invalid PHP overlay output/);
  assert.throws(() => phpRuntimeAssetPath('8.3', archive, {}), /outputs must be unique/);
});
