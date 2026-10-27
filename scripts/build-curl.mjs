import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified, hashFile, inventory } from './assets.mjs';
import { curlSource } from './curl.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const minor = process.argv[2] ?? '8.4';
const version = pins.php.find(entry => entry.version === minor);
if (!version) throw new Error(`Unsupported PHP version: ${minor}`);
const bridge = path.resolve(root, process.env.BRIDGE_SOURCE_DIR || '../mariadb-wasm-bridge');
const cache = path.resolve(root, process.env.CURL_PHP_SOURCE_CACHE || path.join(bridge, '.native-build/upstream'));
const source = path.join(cache, `php-${version.patchVersion}`);
const output = path.resolve(root, process.argv[3] || '.cache/curl');
const compilerVersion = execFileSync('emcc', ['-dumpversion'], { encoding: 'utf8' }).trim();
if (compilerVersion !== pins.upstream.emscripten) throw new Error(`Emscripten ${pins.upstream.emscripten} is required.`);
const phpArchive = path.join(cache, `php-${version.patchVersion}.tar.xz`);
if (await hashFile(phpArchive) !== version.sourceSha256) throw new Error('PHP source archive differs from the runtime pin.');
const header = await readFile(path.join(source, 'main/php_config.h'), 'utf8');
for (const type of ['INT', 'LONG', 'SIZE_T']) {
  if (!new RegExp(`^#define SIZEOF_${type} 4$`, 'm').test(header)) throw new Error('Run the pinned native PDO builder first to prepare wasm32 PHP headers.');
}
const versionHeader = await readFile(path.join(source, 'main/php_version.h'), 'utf8');
if (!versionHeader.includes(`#define PHP_VERSION "${version.patchVersion}"`)) throw new Error('PHP headers have the wrong version.');
const archive = await downloadVerified(curlSource.url, curlSource.sha256,
  path.join(root, '.cache', `php-wasm-curl-${curlSource.commit}.tar.gz`));

// Compile fresh sources from both verified archives. Only the matching wasm32
// PHP configuration headers are reused from the native PDO build.
const scratch = await mkdtemp(path.join(cache, 'curl-source-'));
try {
  execFileSync('tar', ['--extract', '--gzip', '--file', archive, '--directory', scratch, '--no-same-owner']);
  const librarySource = path.join(scratch, `php-wasm-curl-${curlSource.commit}`);
  const curlSourceInventory = await inventory(librarySource);
  execFileSync('tar', ['--extract', '--xz', '--file', phpArchive, '--directory', scratch, '--no-same-owner',
    `php-${version.patchVersion}/ext/curl`, `php-${version.patchVersion}/LICENSE`]);
  const extensionSource = path.join(scratch, `php-${version.patchVersion}/ext/curl`);
  const configuration = await readFile(path.join(extensionSource, 'config.m4'), 'utf8');
  const sources = ['interface.c', 'multi.c', 'share.c', 'curl_file.c'];
  if (!configuration.includes(sources.join(' '))) throw new Error('Review the changed curl extension build inputs.');
  // The upstream Makefile keeps EM_JS objects out of LTO so their JavaScript
  // bodies remain available to the published runtime's dynamic module loader.
  execFileSync('make', ['-j2', 'CFLAGS=-O3 -flto'], { cwd: librarySource, stdio: 'inherit' });
  const flags = ['-O3', '-fPIC', '-flto', '-sSIDE_MODULE=1', '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASYNCIFY_IMPORTS=*',
    '-DCOMPILE_DL_CURL=1', '-DHAVE_CURL=1', '-DCURL_DISABLE_TYPECHECK', '-DZEND_ENABLE_STATIC_TSRMLS_CACHE=1'];
  const includes = [path.join(librarySource, 'include'), source,
    ...['main', 'Zend', 'TSRM', 'ext', 'ext/date/lib'].map(name => path.join(source, name)), extensionSource]
    .map(directory => `-I${directory}`);
  await mkdir(output, { recursive: true });
  const basename = `php${minor}-curl`;
  execFileSync('emcc', [...flags, ...includes, ...sources.map(name => path.join(extensionSource, name)),
    '-Wl,--whole-archive', path.join(librarySource, 'build/libcurl.a'), '-Wl,--no-whole-archive',
    '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
  const licenses = [];
  for (const [name, filename] of [
    ['LICENSE.php', path.join(scratch, `php-${version.patchVersion}/LICENSE`)],
    ...['LICENSE', 'LICENSE-GPL', 'COPYING.curl', 'NOTICE'].map(name => [name, path.join(librarySource, name)]),
  ]) {
    const file = `${basename}.${name}`;
    await cp(filename, path.join(output, file));
    licenses.push({ file, sha256: await hashFile(filename) });
  }
  const provenance = {
    schemaVersion: 1, name: 'curl', phpMinor: minor, phpVersion: version.patchVersion,
    upstream: { repository: pins.upstream.repository, commit: pins.upstream.commit, runtimeVersion: pins.upstream.version },
    emscriptenVersion: compilerVersion,
    phpSource: { url: `https://www.php.net/distributions/php-${version.patchVersion}.tar.xz`, sha256: version.sourceSha256 },
    curlSource, buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)),
    sources, phpSourceInventory: await inventory(extensionSource), curlSourceInventory, flags,
    licenses, extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
  };
  await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Built ${path.join(output, `${basename}.so`)} from pinned PHP and upstream fetch-backed curl sources.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
