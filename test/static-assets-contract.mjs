import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Exercise the service worker cache against files in the real PHP filesystem. */
export async function assertStaticAssetValidation(page) {
  const filename = `rocket-cache-${randomUUID()}.txt`;
  const result = await page.evaluate(async filename => {
    const file = `/persist/www/${filename}`;
    const phpFile = file.replace(/\.txt$/, '.php');
    const url = new URL(filename, window.playground.baseUrl).href;
    const read = async (method = 'GET') => {
      const response = await fetch(url, { method });
      return { text: await response.text(), status: response.status,
        etag: response.headers.get('ETag'), cache: response.headers.get('Cache-Control') };
    };
    try {
      await window.playground.fs.writeFile(file, new TextEncoder().encode('first'));
      const head = await read('HEAD'), first = await read(), repeated = await read();
      await window.playground.fs.writeFile(file, new TextEncoder().encode('other'));
      const changed = await read();
      await window.playground.fs.writeFile(phpFile, new TextEncoder().encode('<?php header("x-php-wasm-cache-time: 1"); echo "dynamic";'));
      const dynamic = await fetch(url.replace(/\.txt$/, '.php'));
      return { head, first, repeated, changed, dynamic: { text: await dynamic.text(), cache: dynamic.headers.get('Cache-Control'), etag: dynamic.headers.get('ETag') } };
    } finally {
      await window.playground.fs.unlink(file);
      await window.playground.fs.unlink(phpFile).catch(() => {});
    }
  }, filename);
  assert.equal(result.first.status, 200);
  assert.equal(result.first.text, 'first');
  assert.equal(result.first.cache, 'private, no-cache');
  assert.match(result.first.etag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(result.head, { ...result.first, text: '' },
    'A static HEAD must use the file contents validator while returning no response body.');
  assert.deepEqual(result.repeated, result.first);
  assert.equal(result.changed.text, 'other', 'Editing a same-size asset must immediately replace its cached contents.');
  assert.notEqual(result.changed.etag, result.first.etag);
  assert.deepEqual(result.dynamic, { text: 'dynamic', cache: 'no-store', etag: null },
    'A PHP response cannot opt into file caching by supplying the upstream static header.');
  return { validatedStaticAssets: true, liveAssetEdits: true, dynamicNoStore: true };
}
