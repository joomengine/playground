import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPhpRuntime } from './php-runtime.mjs';
import { hashFile } from './assets.mjs';

export const nativeRoot = fileURLToPath(new URL('../', import.meta.url));

export function runtimeIdentity(version) {
  return { fingerprint: version.runtimeFingerprint, archiveSha256: version.runtimeArchiveSha256, abi: version.manifest.abi };
}

export async function matchesNativeRuntime(provenance, version, upstream) {
  const identity = runtimeIdentity(version);
  return provenance.nativeHelperSha256 === await hashFile(fileURLToPath(import.meta.url))
    && provenance.phpMinor === version.version && provenance.phpVersion === version.patchVersion
    && provenance.phpSource?.commit === version.sourceCommit
    && provenance.upstream?.commit === upstream.commit && provenance.upstream?.runtimeVersion === upstream.version
    && provenance.emscriptenVersion === upstream.emscripten
    && provenance.runtime?.fingerprint === identity.fingerprint && provenance.runtime?.archiveSha256 === identity.archiveSha256
    && Object.entries(identity.abi).every(([key, value]) => provenance.runtime?.abi?.[key] === value)
    && provenance.flags?.includes('-DZEND_WASM_INT64=1');
}

/** Use installed SDK headers from the exact selected runtime, never host configure output. */
export async function nativeBuildContext(minor) {
  const versions = JSON.parse(await readFile(path.join(nativeRoot, 'versions.json'), 'utf8'));
  const pins = await loadPhpRuntime({ root: nativeRoot, versions, minor });
  const version = pins.php.find(entry => entry.version === (minor || pins.defaults.phpVersion));
  if (!version) throw new Error(`Unsupported PHP version: ${minor}`);
  const compilerVersion = execFileSync('emcc', ['-dumpversion'], { encoding: 'utf8' }).trim();
  if (compilerVersion !== pins.upstream.emscripten) throw new Error(`Emscripten ${pins.upstream.emscripten} is required.`);
  const sdk = version.sdkDirectory;
  const configuration = await readFile(path.join(sdk, 'main/php_config.h'), 'utf8');
  for (const [name, value] of [['INT', 4], ['LONG', 4], ['SIZE_T', 4]]) {
    if (!new RegExp(`^#define SIZEOF_${name} ${value}$`, 'm').test(configuration)) throw new Error('The selected PHP SDK is not wasm32.');
  }
  if (!/^#define ZEND_WASM_INT64 1$/m.test(configuration)) throw new Error('The selected PHP SDK lacks the int64 ABI marker.');
  if (!(await readFile(path.join(sdk, 'main/php_version.h'), 'utf8')).includes(`#define PHP_VERSION "${version.patchVersion}"`)) {
    throw new Error('The selected PHP SDK has the wrong source version.');
  }
  const includes = [sdk, ...['main', 'Zend', 'TSRM', 'ext', 'ext/date/lib'].map(name => path.join(sdk, name))];
  const flags = ['-O3', '-fPIC', '-sSIDE_MODULE=1', '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASYNCIFY_IMPORTS=*',
    '-DZEND_WASM_INT64=1', '-DZEND_ENABLE_STATIC_TSRMLS_CACHE=1'];
  return { pins, version, compilerVersion, sdk, includes, flags, nativeHelperSha256: await hashFile(fileURLToPath(import.meta.url)) };
}

/** Reconstruct only PHP sources required by extensions from the release's immutable inputs. */
export async function preparePhpNativeSource(version) {
  if (!/^[a-f0-9]{40}$/.test(version.sourceCommit) || !/^[a-f0-9]{64}$/.test(version.runtimeFingerprint)) {
    throw new Error('A verified PHP source commit and runtime fingerprint are required.');
  }
  const cache = path.join(nativeRoot, '.cache/php-native');
  await mkdir(cache, { recursive: true });
  const destination = path.join(cache, `${version.version}-${version.runtimeFingerprint}`);
  const marker = { commit: version.sourceCommit, fingerprint: version.runtimeFingerprint };
  try {
    if (JSON.stringify(JSON.parse(await readFile(path.join(destination, '.playground-source.json'), 'utf8'))) === JSON.stringify(marker)) return destination;
    throw new Error('Prepared PHP source identity changed.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const scratch = await mkdtemp(path.join(cache, 'prepare-'));
  try {
    const git = args => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    git(['init', '--quiet']);
    git(['remote', 'add', 'origin', 'https://github.com/php/php-src.git']);
    git(['fetch', '--depth=1', 'origin', version.sourceCommit]);
    git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    if (git(['rev-parse', 'HEAD']) !== version.sourceCommit) throw new Error('Downloaded PHP source commit differs from the runtime.');
    for (const series of ['runtime', 'php']) {
      const patch = path.join(version.runtimeDirectory, 'build-inputs/patches', series, `${version.version}.patch`);
      git(['apply', '--check', patch]);
      git(['apply', patch]);
    }
    if (!(await readFile(path.join(scratch, 'main/php_version.h'), 'utf8')).includes(`#define PHP_VERSION "${version.patchVersion}"`)) {
      throw new Error('Downloaded PHP source version differs from the runtime.');
    }
    await writeFile(path.join(scratch, '.playground-source.json'), `${JSON.stringify(marker)}\n`);
    await rename(scratch, destination);
    return destination;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function nativeProvenance(context) {
  const { pins, version, compilerVersion } = context;
  return {
    phpMinor: version.version, phpVersion: version.patchVersion, nativeHelperSha256: context.nativeHelperSha256,
    upstream: { repository: pins.upstream.repository, commit: pins.upstream.commit, runtimeVersion: pins.upstream.version },
    emscriptenVersion: compilerVersion, phpSource: { commit: version.sourceCommit }, runtime: runtimeIdentity(version),
  };
}
