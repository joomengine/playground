import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../scripts/assets.mjs';
import { loadPhpRuntime, phpRuntimeSelectionPath, resolvePhpRuntime, validatePhpRuntimeManifest } from '../scripts/php-runtime.mjs';

const repository = 'joomengine/php-wasm-int64';
const minor = '8.4';
const version = '3.2.1';
const packageNames = ['php-wasm', 'php-cgi-wasm', 'php-cli-wasm', 'php-dbg-wasm', 'zlib', 'libxml', 'xml', 'dom',
  'simplexml', 'xmlreader', 'xmlwriter', 'iconv', 'mbstring', 'intl', 'libzip', 'gd', 'openssl', 'phar', 'sqlite'];

// Tiny archives exercise download identity and SDK selection, never claim runtime coverage.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'playground-php-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'fixture', `php-${minor}`);
  const files = {};
  const payload = { LICENSE: 'License fixture', NOTICE: 'Notice fixture',
    'include/main/php_config.h': '#define ZEND_WASM_INT64 1\n', 'include/Zend/zend_long.h': 'int64 SDK fixture',
    'build-inputs/versions.json': '{}', ...Object.fromEntries(packageNames.map(name => [`packages/${name}/package.json`, JSON.stringify({ name })])) };
  for (const [name, bytes] of Object.entries(payload)) {
    const filename = path.join(directory, name);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, bytes);
    files[name] = { size: Buffer.byteLength(bytes), sha256: sha256(Buffer.from(bytes)) };
  }
  const manifest = { schemaVersion: 1, name: 'php-wasm-int64', version,
    php: { minor, version: `${minor}.123`, commit: 'a'.repeat(40) },
    upstream: { repository: 'https://github.com/seanmorris/php-wasm.git', version: 'fixture', commit: 'b'.repeat(40) },
    fingerprint: 'c'.repeat(64), build: { fingerprint: 'c'.repeat(64) },
    abi: { target: 'wasm32-unknown-emscripten', integerBits: 64, pointerBits: 32, define: 'ZEND_WASM_INT64=1' },
    emscripten: { version: '6.0.6', image: `emscripten/emsdk:6.0.6@sha256:${'d'.repeat(64)}` }, files };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const archive = path.join(root, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', path.dirname(directory), path.basename(directory)]);
  const digest = sha256(await readFile(archive));
  const cache = path.join(root, '.cache/php-int64');
  await mkdir(cache, { recursive: true });
  await cp(archive, path.join(cache, `${digest}.tar.gz`));
  const name = `php-wasm-int64-${version}-php${minor}.tar.gz`;
  const release = { tag_name: `v${version}`, target_commitish: 'e'.repeat(40), published_at: '2026-01-01T00:00:00Z',
    draft: false, prerelease: false, assets: [{ name, state: 'uploaded', digest: `sha256:${digest}`,
      browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}` }] };
  const versions = { runtime: { repository, release: 'latest' }, php: [{ version: minor }], defaults: { phpVersion: minor } };
  let requests = 0;
  const fetchImpl = async url => {
    assert.equal(url, `https://api.github.com/repos/${repository}/releases/latest`);
    requests++;
    return new Response(JSON.stringify(release));
  };
  return { root, manifest, release, versions, fetchImpl, requests: () => requests };
}

test('one stable release selects PHP versions and SDK identities from verified manifests', async t => {
  const f = await fixture(t);
  const selection = await resolvePhpRuntime(f);
  assert.equal(selection.version, version);
  assert.equal(selection.archives[0].php.version, `${minor}.123`);
  const loaded = await loadPhpRuntime(f);
  assert.equal(f.requests(), 1, 'Loading build inputs cannot resolve a different latest release.');
  assert.equal(loaded.php[0].patchVersion, f.manifest.php.version);
  assert.equal(loaded.php[0].sourceCommit, f.manifest.php.commit);
  assert.equal(loaded.php[0].runtimeFingerprint, f.manifest.fingerprint);
  assert.equal(loaded.php[0].runtimeArchiveSha256, selection.archives[0].sha256);
  assert.equal(loaded.upstream.emscripten, f.manifest.emscripten.version);
  assert.deepEqual(loaded.php[0].manifest.abi, f.manifest.abi);
});

test('native builds require a previously resolved release selection', async t => {
  const f = await fixture(t);
  await assert.rejects(loadPhpRuntime(f), /not prepared/);
  assert.equal(f.requests(), 0);
});

test('unpublished, prerelease and mutable target releases cannot replace a build selection', async t => {
  for (const change of [{ draft: true }, { prerelease: true }, { published_at: null }, { target_commitish: 'main' }]) {
    const f = await fixture(t);
    Object.assign(f.release, change);
    await assert.rejects(resolvePhpRuntime(f), /not a published stable version/);
    await assert.rejects(readFile(phpRuntimeSelectionPath(f.root)), { code: 'ENOENT' });
  }
});

test('each supported minor requires one checksum-identified official release archive', async t => {
  for (const change of [
    release => { release.assets = []; },
    release => { release.assets.push({ ...release.assets[0] }); },
    release => { release.assets[0].digest = 'missing'; },
    release => { release.assets[0].browser_download_url = 'https://unrelated.test/php.tar.gz'; },
  ]) {
    const f = await fixture(t);
    change(f.release);
    await assert.rejects(resolvePhpRuntime(f), /lacks a verified archive/);
  }
});

test('changed extracted files and mismatched resolved source identities fail closed', async t => {
  for (const kind of ['payload', 'selection']) {
    const f = await fixture(t);
    await resolvePhpRuntime(f);
    const loaded = await loadPhpRuntime(f);
    if (kind === 'payload') {
      await writeFile(path.join(loaded.php[0].runtimeDirectory, 'include/Zend/zend_long.h'), 'changed SDK');
      await assert.rejects(loadPhpRuntime(f), /differs from its manifest/);
    } else {
      const filename = phpRuntimeSelectionPath(f.root);
      const selection = JSON.parse(await readFile(filename, 'utf8'));
      selection.archives[0].php.commit = 'f'.repeat(40);
      await writeFile(filename, JSON.stringify(selection));
      await assert.rejects(loadPhpRuntime(f), /differs from its verified archive/);
    }
  }
});

test('manifest validation requires int64 ABI, complete SDK identity and safe file paths', async t => {
  const f = await fixture(t);
  for (const change of [
    manifest => { manifest.abi.integerBits = 32; },
    manifest => { manifest.abi.pointerBits = 64; },
    manifest => { manifest.php.version = '8.5.123'; },
    manifest => { manifest.files['../outside'] = { size: 0, sha256: 'a'.repeat(64) }; },
    manifest => { delete manifest.files['include/Zend/zend_long.h']; },
  ]) {
    const manifest = structuredClone(f.manifest);
    change(manifest);
    assert.throws(() => validatePhpRuntimeManifest(manifest, { minor, version }), /incompatible runtime identity|Invalid PHP release inventory|missing/);
  }
});
