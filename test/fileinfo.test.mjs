import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hashFile, sha256 } from '../scripts/assets.mjs';
import { stageFileinfo } from '../scripts/fileinfo.mjs';

test('fileinfo staging verifies runtime identity, binary checksum and all licenses', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'fileinfo-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'input');
  const destination = path.join(root, 'output');
  await mkdir(directory);
  await mkdir(destination);
  const version = { version: '8.4', patchVersion: '8.4.1', sourceSha256: 'a'.repeat(64) };
  const upstream = { commit: 'b'.repeat(40), version: '0.2.0', emscripten: '6.0.6' };
  const file = 'php8.4-fileinfo.so';
  const bytes = Buffer.from('wasm extension fixture');
  await writeFile(path.join(directory, file), bytes);
  const licenses = [];
  for (const name of ['LICENSE.php', 'LICENSE.libmagic', 'NOTICES']) {
    const entry = { file: `php8.4-fileinfo.${name}`, sha256: sha256(Buffer.from(name)) };
    await writeFile(path.join(directory, entry.file), name);
    licenses.push(entry);
  }
  const provenance = { schemaVersion: 1, name: 'fileinfo', phpMinor: version.version, phpVersion: version.patchVersion,
    upstream: { commit: upstream.commit, runtimeVersion: upstream.version }, emscriptenVersion: upstream.emscripten,
    phpSource: { sha256: version.sourceSha256 }, extension: { file, sha256: sha256(bytes) },
    magicDatabase: { embedded: true, source: 'ext/fileinfo/data_file.c', sha256: 'c'.repeat(64) },
    sourceInventory: [{ path: 'data_file.c', sha256: 'c'.repeat(64) }], licenses,
    buildScriptSha256: await hashFile(fileURLToPath(new URL('../scripts/build-fileinfo.mjs', import.meta.url))) };
  const save = () => writeFile(path.join(directory, 'php8.4-fileinfo.json'), JSON.stringify(provenance));
  const options = { directory, destination, version, upstream };
  await save();
  const result = await stageFileinfo(options);
  assert.equal(result.url, 'extensions/php8.4-fileinfo.so');
  assert.deepEqual(await readFile(path.join(destination, file)), bytes);
  for (const license of licenses) assert.equal(await hashFile(path.join(destination, license.file)), license.sha256);
  provenance.phpVersion = '8.5.2';
  await save();
  await assert.rejects(stageFileinfo(options), /provenance differs/);
  provenance.phpVersion = version.patchVersion;
  await save();
  await writeFile(path.join(directory, file), 'substituted module');
  await assert.rejects(stageFileinfo(options), /provenance differs/);
  await writeFile(path.join(directory, file), bytes);
  await writeFile(path.join(directory, licenses[0].file), 'changed license');
  await assert.rejects(stageFileinfo(options), /license checksum mismatch/);
});
