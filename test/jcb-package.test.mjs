import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { applyJoomlaConfiguration } from '../src/joomla/index.mjs';

const text = value => new TextEncoder().encode(value);
const digest = bytes => createHash('sha512').update(bytes).digest('hex');
const reader = new Uint8Array(gunzipSync(await readFile(new URL('./fixtures/jcb-chunk-read-filter.php.gz', import.meta.url))));
const installed = new Uint8Array(gunzipSync(await readFile(new URL('./fixtures/jcb-spreadsheet-source-installed.json.gz', import.meta.url))));
const component = zipSync({
  'component-builder/libraries/vendor_jcb/VDM.Joomla/src/Import/Spreadsheet/ChunkReadFilter.php': reader,
  'component-builder/libraries/phpspreadsheet/vendor/composer/installed.json': installed,
  'component-builder/libraries/phpspreadsheet/vendor/autoload.php': text('<?php // Original vendor tree.'),
});
const candidate = zipSync({
  'pkg-component-builder-6.2.1-alpha1/pkg_component_builder.xml': text('<extension><version>6.2.1-alpha1</version></extension>'),
  'pkg-component-builder-6.2.1-alpha1/src/joomla__Component-Builder__6.x.zip': component,
  'pkg-component-builder-6.2.1-alpha1/src/plugin.zip': text('Original companion plugin'),
});

function fixture(sha512 = digest(candidate)) {
  const sourceURL = 'https://example.test/jcb.zip';
  const item = { url: sourceURL, sha512 };
  const requested = [];
  const writes = [];
  const runtime = {
    fs: { writeFile: async (path, bytes) => writes.push({ path, bytes }) },
    runPhp: async source => {
      const operation = [...source.matchAll(/operation:([a-z]+)/g)].at(-1)?.[1];
      return { status: 200, text: '\n__JOOMENGINE_RESULT__' + JSON.stringify(operation === 'status'
        ? { ok: true, marker: { state: 'complete', joomlaVersion: '6.2.0' }, configured: true, installerPresent: false }
        : { ok: false, error: 'Stop after observing the package' }) };
    },
  };
  const config = { joomlaVersion: '6.2.0', jcbVersion: '6.2.1-alpha1', jcbPackage: item,
    admin: { password: 'Local-Demo-Password-123!' }, extensions: [item] };
  const options = {
    fetchPackage: async url => { requested.push(String(url)); assert.equal(url, sourceURL); return new Response(candidate); },
    sourceLoader: async name => `<?php\n// operation:${name}\n`,
  };
  return { run: () => applyJoomlaConfiguration(runtime, config, options), requested, writes, sourceURL };
}

test('selected JCB packages reach the installer byte-for-byte without dependency substitution', async () => {
  const item = fixture();
  await assert.rejects(item.run(), /Stop after observing the package/);
  assert.deepEqual(item.requested, [item.sourceURL], 'Installing JCB must not fetch a replacement dependency donor.');
  assert.equal(item.writes.length, 1);
  assert.deepEqual(new Uint8Array(item.writes[0].bytes), candidate);
});

test('selected JCB package integrity is still enforced before writing the installer archive', async () => {
  const item = fixture('0'.repeat(128));
  await assert.rejects(item.run(), /checksum|SHA-512/i);
  assert.deepEqual(item.requested, [item.sourceURL]);
  assert.deepEqual(item.writes, []);
});
