import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified, hashFile, inventory } from './assets.mjs';
import { sodiumSource } from './sodium.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const minor = process.argv[2] ?? '8.4';
const version = pins.php.find(entry => entry.version === minor);
if (!version) throw new Error(`Unsupported PHP version: ${minor}`);
const bridge = path.resolve(root, process.env.BRIDGE_SOURCE_DIR || '../mariadb-wasm-bridge');
const cache = path.resolve(root, process.env.SODIUM_PHP_SOURCE_CACHE || path.join(bridge, '.native-build/upstream'));
const source = path.join(cache, `php-${version.patchVersion}`);
const output = path.resolve(root, process.argv[3] || '.cache/sodium');
const compilerVersion = execFileSync('emcc', ['-dumpversion'], { encoding: 'utf8' }).trim();
if (compilerVersion !== pins.upstream.emscripten) throw new Error(`Emscripten ${pins.upstream.emscripten} is required.`);
const phpArchive = path.join(cache, `php-${version.patchVersion}.tar.xz`);
if (await hashFile(phpArchive) !== version.sourceSha256) throw new Error('PHP source archive differs from the runtime pin.');
const header = await readFile(path.join(source, 'main/php_config.h'), 'utf8');
for (const type of ['INT', 'LONG', 'SIZE_T']) {
  if (!new RegExp(`^#define SIZEOF_${type} 4$`, 'm').test(header)) throw new Error('Prepare the version-matched wasm32 PHP headers first.');
}
const versionHeader = await readFile(path.join(source, 'main/php_version.h'), 'utf8');
if (!versionHeader.includes(`#define PHP_VERSION "${version.patchVersion}"`)) throw new Error('PHP headers have the wrong version.');
const archive = await downloadVerified(sodiumSource.url, sodiumSource.sha256,
  path.join(root, '.cache', `libsodium-${sodiumSource.version}.tar.gz`));
const scratch = await mkdtemp(path.join(cache, 'sodium-source-'));
try {
  execFileSync('tar', ['--extract', '--gzip', '--file', archive, '--directory', scratch, '--no-same-owner']);
  const librarySource = path.join(scratch, `libsodium-${sodiumSource.version}`);
  const sodiumSourceInventory = await inventory(librarySource);
  const prefix = path.join(scratch, 'installed');
  // Upstream's Emscripten recipe disables native assembly, threads and stack
  // protectors. Keep EM_ASM objects out of LTO for loadable-module JS metadata.
  const libraryFlags = ['-O3', '-fPIC'];
  const configureFlags = ['--host=wasm32-unknown-emscripten', '--disable-shared', '--enable-static', '--without-pthreads', '--disable-ssp', '--disable-asm', '--disable-pie'];
  execFileSync('emconfigure', ['./configure', ...configureFlags, `--prefix=${prefix}`],
    { cwd: librarySource, env: { ...process.env, CFLAGS: libraryFlags.join(' ') }, stdio: 'inherit' });
  execFileSync('emmake', ['make', '-j2', 'install'], { cwd: librarySource, stdio: 'inherit' });
  execFileSync('tar', ['--extract', '--xz', '--file', phpArchive, '--directory', scratch, '--no-same-owner',
    `php-${version.patchVersion}/ext/sodium`, `php-${version.patchVersion}/LICENSE`]);
  const extensionSource = path.join(scratch, `php-${version.patchVersion}/ext/sodium`);
  const sources = ['libsodium.c', 'sodium_pwhash.c'];
  const configuration = await readFile(path.join(extensionSource, 'config.m4'), 'utf8');
  for (const filename of sources) if (!configuration.includes(filename)) throw new Error('Review the changed sodium extension source list.');
  const flags = ['-O3', '-fPIC', '-sSIDE_MODULE=1', '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASYNCIFY_IMPORTS=*',
    '-DCOMPILE_DL_SODIUM=1', '-DHAVE_LIBSODIUMLIB=1', '-DZEND_ENABLE_STATIC_TSRMLS_CACHE=1', '-Wno-type-limits'];
  const includes = [path.join(prefix, 'include'), source,
    ...['main', 'Zend', 'TSRM', 'ext'].map(name => path.join(source, name)), extensionSource].map(directory => `-I${directory}`);
  await mkdir(output, { recursive: true });
  const basename = `php${minor}-sodium`;
  execFileSync('emcc', [...flags, ...includes, ...sources.map(name => path.join(extensionSource, name)),
    path.join(prefix, 'lib/libsodium.a'), '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
  const licenses = [];
  for (const [name, filename] of [['LICENSE.php', path.join(scratch, `php-${version.patchVersion}/LICENSE`)], ['LICENSE.libsodium', path.join(librarySource, 'LICENSE')]]) {
    const file = `${basename}.${name}`;
    await cp(filename, path.join(output, file));
    licenses.push({ file, sha256: await hashFile(filename) });
  }
  const provenance = {
    schemaVersion: 1, name: 'sodium', phpMinor: minor, phpVersion: version.patchVersion,
    upstream: { repository: pins.upstream.repository, commit: pins.upstream.commit, runtimeVersion: pins.upstream.version },
    emscriptenVersion: compilerVersion,
    phpSource: { url: `https://www.php.net/distributions/php-${version.patchVersion}.tar.xz`, sha256: version.sourceSha256 },
    sodiumSource, buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)),
    sources, phpSourceInventory: await inventory(extensionSource), sodiumSourceInventory,
    flags, libraryFlags, configureFlags, licenses,
    extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
  };
  await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Built ${path.join(output, `${basename}.so`)} with libsodium ${sodiumSource.version}.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
