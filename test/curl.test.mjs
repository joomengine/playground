import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hashFile, sha256 } from '../scripts/assets.mjs';
import { curlSource, stageCurl } from '../scripts/curl.mjs';

test('curl staging verifies PHP and fetch transport identities, binary checksum and licenses', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'curl-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'input');
  const destination = path.join(root, 'output');
  await mkdir(directory);
  await mkdir(destination);
  const abi = { target: 'wasm32-unknown-emscripten', integerBits: 64, pointerBits: 32, define: 'ZEND_WASM_INT64=1' };
  const version = { version: '8.4', patchVersion: '8.4.123', sourceCommit: 'a'.repeat(40),
    runtimeFingerprint: 'a'.repeat(64), runtimeArchiveSha256: 'b'.repeat(64), manifest: { abi } };
  const upstream = { commit: 'b'.repeat(40), version: '0.2.0', emscripten: '6.0.6' };
  const file = 'php8.4-curl.so';
  const bytes = Buffer.from('wasm extension fixture');
  await writeFile(path.join(directory, file), bytes);
  const licenses = [];
  for (const name of ['LICENSE.php', 'LICENSE', 'LICENSE-GPL', 'COPYING.curl', 'NOTICE']) {
    const entry = { file: `php8.4-curl.${name}`, sha256: sha256(Buffer.from(name)) };
    await writeFile(path.join(directory, entry.file), name);
    licenses.push(entry);
  }
  const provenance = { schemaVersion: 1, name: 'curl', phpMinor: version.version, phpVersion: version.patchVersion,
    upstream: { commit: upstream.commit, runtimeVersion: upstream.version }, emscriptenVersion: upstream.emscripten,
    phpSource: { commit: version.sourceCommit }, extension: { file, sha256: sha256(bytes) }, curlSource: { ...curlSource },
    runtime: { fingerprint: version.runtimeFingerprint, archiveSha256: version.runtimeArchiveSha256, abi },
    flags: ['-DZEND_WASM_INT64=1'],
    nativeHelperSha256: await hashFile(fileURLToPath(new URL('../scripts/native-runtime.mjs', import.meta.url))),
    nativePatchSha256: await hashFile(fileURLToPath(new URL('../native/curl-int64.patch', import.meta.url))),
    phpSourceInventory: [{ path: 'interface.c', sha256: 'c'.repeat(64) }],
    httpStreams: { sourceSha256: await hashFile(fileURLToPath(new URL('../native/http-stream.c', import.meta.url))),
      originalInterfaceSha256: 'f'.repeat(64), interfaceSha256: 'c'.repeat(64) },
    curlSourceInventory: [{ path: 'src/fetch_js.c', sha256: 'd'.repeat(64) }], licenses,
    buildScriptSha256: await hashFile(fileURLToPath(new URL('../scripts/build-curl.mjs', import.meta.url))) };
  const save = () => writeFile(path.join(directory, 'php8.4-curl.json'), JSON.stringify(provenance));
  const options = { directory, destination, version, upstream };
  await save();
  assert.equal((await stageCurl(options)).url, 'extensions/php8.4-curl.so');
  assert.deepEqual(await readFile(path.join(destination, file)), bytes);
  for (const license of licenses) assert.equal(await hashFile(path.join(destination, license.file)), license.sha256);
  const patchSha256 = provenance.nativePatchSha256;
  provenance.nativePatchSha256 = '0'.repeat(64);
  await save();
  await assert.rejects(stageCurl(options), /provenance differs/);
  provenance.nativePatchSha256 = patchSha256;
  provenance.phpVersion = '8.5.2';
  await save();
  await assert.rejects(stageCurl(options), /provenance differs/);
  provenance.phpVersion = version.patchVersion;
  provenance.runtime.fingerprint = 'f'.repeat(64);
  await save();
  await assert.rejects(stageCurl(options), /provenance differs/);
  provenance.runtime.fingerprint = version.runtimeFingerprint;
  provenance.flags = [];
  await save();
  await assert.rejects(stageCurl(options), /provenance differs/);
  provenance.flags = ['-DZEND_WASM_INT64=1'];
  provenance.curlSource.commit = 'e'.repeat(40);
  await save();
  await assert.rejects(stageCurl(options), /provenance differs/);
  provenance.curlSource = curlSource;
  await save();
  await writeFile(path.join(directory, file), 'substituted module');
  await assert.rejects(stageCurl(options), /provenance differs/);
  await writeFile(path.join(directory, file), bytes);
  await writeFile(path.join(directory, licenses[0].file), 'changed license');
  await assert.rejects(stageCurl(options), /license checksum mismatch/);
});
