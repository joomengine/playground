import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { extractTarGzip, inventory, safeArchivePath, verifyBridgeBundle } from '../scripts/assets.mjs';

function tar(entries) {
  const chunks = [];
  for (const { name, type = '0', content = '' } of entries) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'playground-assets-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('archive paths reject traversal, absolute names and platform separators', () => {
  for (const name of ['../escape', '/tmp/escape', 'safe/../../escape', 'C:/escape', 'safe\\escape', 'safe/\0escape', 'safe/./file', 'safe//file']) {
    assert.throws(() => safeArchivePath(name), /Unsafe archive path/);
  }
  assert.equal(safeArchivePath('bundle/src/worker.mjs'), 'bundle/src/worker.mjs');
});

test('release extraction handles regular files and validates checksums', async t => {
  const directory = await temporary(t);
  const archive = path.join(directory, 'release.tar.gz');
  await writeFile(archive, tar([{ name: 'bundle/', type: '5' }, { name: 'bundle/a.txt', content: 'verified' }]));
  await extractTarGzip(archive, path.join(directory, 'out'));
  assert.equal(await readFile(path.join(directory, 'out/bundle/a.txt'), 'utf8'), 'verified');
  const corrupt = gunzipSync(tar([{ name: 'bundle/file' }]));
  corrupt[0] ^= 1;
  await writeFile(archive, gzipSync(corrupt));
  await assert.rejects(extractTarGzip(archive, path.join(directory, 'corrupt')), /checksum/);
});

test('release extraction refuses links, traversal and duplicate paths', async t => {
  const directory = await temporary(t);
  const badArchives = [
    [{ name: 'bundle/link', type: '2' }],
    [{ name: '../escape' }],
    [{ name: 'bundle/file', content: 'first' }, { name: 'bundle/file', content: 'replacement' }],
  ];
  for (const [index, entries] of badArchives.entries()) {
    const archive = path.join(directory, `${index}.tar.gz`);
    await writeFile(archive, tar(entries));
    await assert.rejects(extractTarGzip(archive, path.join(directory, `${index}`)), /Unsupported|Unsafe|Duplicate/);
  }
});

test('bridge verification detects substituted assets and unexpected files', async t => {
  const directory = await temporary(t);
  await mkdir(path.join(directory, 'src'));
  const file = path.join(directory, 'src/index.mjs');
  await writeFile(file, 'export const version = 1;');
  const files = Object.fromEntries((await inventory(directory)).map(entry => [entry.path, { bytes: entry.size, sha256: entry.sha256 }]));
  const expected = { version: '0.1.1', protocolVersion: 1, sourceCommit: 'a'.repeat(40) };
  await writeFile(path.join(directory, 'bridge-manifest.json'), JSON.stringify({
    bridgeVersion: expected.version, protocolVersion: expected.protocolVersion, sourceCommit: expected.sourceCommit, files,
  }));
  await verifyBridgeBundle(directory, expected);
  await writeFile(file, 'export const version = 2;');
  await assert.rejects(verifyBridgeBundle(directory, expected), /Bridge asset mismatch/);
  await writeFile(path.join(directory, 'unexpected.mjs'), '');
  await assert.rejects(verifyBridgeBundle(directory, expected), /inventory mismatch/);
});
