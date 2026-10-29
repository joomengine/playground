import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from './assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const minor = process.argv[2] ?? pins.defaults.phpVersion;
const version = pins.php.find(entry => entry.version === minor);
if (!version) throw new Error(`Unsupported PHP version: ${minor}`);
const bridge = path.resolve(root, process.env.BRIDGE_SOURCE_DIR || '../mariadb-wasm-bridge');
const cache = path.resolve(root, process.env.PHPDBG_PHP_SOURCE_CACHE || path.join(bridge, '.native-build/upstream'));
const source = path.join(cache, `php-${version.patchVersion}`);
const output = path.resolve(root, process.argv[3] || '.cache/phpdbg');
const compilerVersion = execFileSync('emcc', ['-dumpversion'], { encoding: 'utf8' }).trim();
if (compilerVersion !== pins.upstream.emscripten) throw new Error(`Emscripten ${pins.upstream.emscripten} is required.`);
if (await hashFile(path.join(cache, `php-${version.patchVersion}.tar.xz`)) !== version.sourceSha256) {
  throw new Error('PHP source archive differs from the debugger runtime pin.');
}
const header = await readFile(path.join(source, 'main/php_config.h'), 'utf8');
for (const type of ['INT', 'LONG', 'SIZE_T']) {
  if (!new RegExp(`^#define SIZEOF_${type} 4$`, 'm').test(header)) throw new Error('Run the pinned native PDO builder first to prepare wasm32 PHP headers.');
}
const versionHeader = await readFile(path.join(source, 'main/php_version.h'), 'utf8');
if (!versionHeader.includes(`#define PHP_VERSION "${version.patchVersion}"`)) throw new Error('PHP headers have the wrong version.');
const extensionSource = path.join(root, 'native/phpdbg/jec_phpdbg_http.c');
const flags = ['-O3', '-flto', '-sSIDE_MODULE=1', '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASYNCIFY_IMPORTS=*',
  '-DCOMPILE_DL_JEC_PHPDBG_HTTP=1', '-DZEND_ENABLE_STATIC_TSRMLS_CACHE=1'];
const includes = [source, ...['main', 'Zend', 'TSRM', 'ext', 'sapi/phpdbg'].map(name => path.join(source, name))]
  .map(directory => `-I${directory}`);
await mkdir(output, { recursive: true });
const basename = `php${minor}-jec-phpdbg-http`;
execFileSync('emcc', [...flags, ...includes, extensionSource, '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
const licenseFile = `${basename}.LICENSE`;
await cp(path.join(root, 'LICENSE'), path.join(output, licenseFile));
const provenance = {
  schemaVersion: 1, name: 'jec_phpdbg_http', phpMinor: minor, phpVersion: version.patchVersion,
  upstream: { repository: pins.upstream.repository, commit: pins.upstream.commit, runtimeVersion: pins.upstream.version },
  emscriptenVersion: compilerVersion,
  phpSource: { sha256: version.sourceSha256 },
  sourceSha256: await hashFile(extensionSource), buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)), flags,
  licenses: [{ file: licenseFile, sha256: await hashFile(path.join(output, licenseFile)) }],
  extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
};
await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Built ${path.join(output, `${basename}.so`)} against pinned PHP ${version.patchVersion}.`);
