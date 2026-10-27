import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { JCB_SOURCE_OVERLAY, applyJcbCompatibilityOverlay } from '../scripts/jcb-platform-overlay.mjs';
import { JCB_VENDOR_OVERLAYS, applyJcbVendorOverlay } from '../scripts/jcb-vendor-overlay.mjs';

test('JCB reader compatibility changes only the reviewed return declaration', async () => {
  const original = new Uint8Array(gunzipSync(await readFile(new URL('./fixtures/jcb-chunk-read-filter.php.gz', import.meta.url))));
  const untouched = new Uint8Array([1, 2, 3]);
  const files = { [JCB_SOURCE_OVERLAY.path]: original, 'untouched.txt': untouched };
  const patched = applyJcbCompatibilityOverlay(files);
  assert.equal(new TextDecoder().decode(patched[JCB_SOURCE_OVERLAY.path]),
    new TextDecoder().decode(original).replace(JCB_SOURCE_OVERLAY.before, JCB_SOURCE_OVERLAY.after));
  assert.equal(files[JCB_SOURCE_OVERLAY.path], original);
  assert.equal(patched['untouched.txt'], untouched);
  assert.throws(() => applyJcbCompatibilityOverlay(patched), /reviewed compatibility source/);
  assert.throws(() => applyJcbCompatibilityOverlay({ ...files, [JCB_SOURCE_OVERLAY.path]: new Uint8Array([...original, 10]) }), /reviewed compatibility source/);
  assert.throws(() => applyJcbCompatibilityOverlay({}), /reviewed compatibility source/);
});

test('spreadsheet source corrections reject unreviewed or incomplete vendor trees', () => {
  assert.throws(() => applyJcbVendorOverlay({}), /reviewed compatibility input/);
  const files = Object.fromEntries(JCB_VENDOR_OVERLAYS.map((overlay) => [overlay.path,
    new TextEncoder().encode(overlay.replacements.map((replacement) => replacement.before).join('\n'))]));
  assert.throws(() => applyJcbVendorOverlay(files), /reviewed compatibility input/);
});
