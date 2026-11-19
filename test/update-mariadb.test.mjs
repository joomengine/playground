import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { sha256 } from '../scripts/assets.mjs';
import { selectBridge } from '../scripts/update-mariadb.mjs';

const pins = JSON.parse(await readFile(new URL('../versions.json', import.meta.url)));
function fixture(version = pins.bridge.version) {
  const release = { published_at: '2026-11-19', target_commitish: pins.bridge.sourceCommit, tag_name: `v${version}`, assets: [] };
  const files = {};
  for (const [key, directory] of [['nativeSources', 'native'], ['adapterSources', 'adapters'], ['runtimeSources', 'src']]) {
    for (const [name, sha256] of Object.entries(pins.nativeDriver[key])) files[directory + '/' + name] = { sha256 };
  }
  const bytes = JSON.stringify({ schemaVersion: 1, bridgeVersion: version, protocolVersion: pins.bridge.protocolVersion, sourceCommit: release.target_commitish, files });
  for (const [name, hash] of [['bridge-manifest.json', sha256(bytes)], [`mariadb-wasm-bridge-${version}.tar.gz`, pins.bridge.sha256]]) {
    release.assets.push({ name, state: 'uploaded', digest: 'sha256:' + hash,
      browser_download_url: `https://github.com/joomengine/mariadb-wasm-bridge/releases/download/${release.tag_name}/${name}` });
  }
  return [release, bytes];
}
test('select coherent MariaDB bridge archive and native inputs', () => {
  assert.deepEqual(selectBridge(pins, ...fixture()), pins);
  const next = `${Number(pins.bridge.version.split('.')[0]) + 1}.0.0`;
  const updated = selectBridge(pins, ...fixture(next));
  assert.equal(updated.bridge.version, next);
  assert.ok(updated.bridge.url.endsWith(`-${next}.tar.gz`));
  const [release, bytes] = fixture();
  assert.throws(() => selectBridge(pins, release, bytes + ' '), /digest/);
  release.assets[1].digest = 'sha256:' + '1'.repeat(64);
  assert.throws(() => selectBridge(pins, release, bytes), /changed in place/);
  assert.throws(() => selectBridge(pins, ...fixture('0.0.0')), /downgrade/);
});
