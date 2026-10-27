import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, inventory } from './assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const minor = process.argv[2] ?? '8.4';
const version = pins.php.find(entry => entry.version === minor);
if (!version) throw new Error(`Unsupported PHP version: ${minor}`);
const bridge = path.resolve(root, process.env.BRIDGE_SOURCE_DIR || '../mariadb-wasm-bridge');
const cache = path.resolve(root, process.env.FILEINFO_PHP_SOURCE_CACHE || path.join(bridge, '.native-build/upstream'));
const source = path.join(cache, `php-${version.patchVersion}`);
const output = path.resolve(root, process.argv[3] || '.cache/fileinfo');
const compilerVersion = execFileSync('emcc', ['-dumpversion'], { encoding: 'utf8' }).trim();
if (compilerVersion !== pins.upstream.emscripten) throw new Error(`Emscripten ${pins.upstream.emscripten} is required.`);
if (await hashFile(path.join(cache, `php-${version.patchVersion}.tar.xz`)) !== version.sourceSha256) {
  throw new Error('PHP source archive differs from the runtime pin.');
}
const header = await readFile(path.join(source, 'main/php_config.h'), 'utf8');
for (const type of ['INT', 'LONG', 'SIZE_T']) {
  if (!new RegExp(`^#define SIZEOF_${type} 4$`, 'm').test(header)) throw new Error('Run the pinned native PDO builder first to prepare wasm32 PHP headers.');
}
const versionHeader = await readFile(path.join(source, 'main/php_version.h'), 'utf8');
if (!versionHeader.includes(`#define PHP_VERSION "${version.patchVersion}"`)) throw new Error('PHP headers have the wrong version.');

// Compile clean extension sources from the verified archive, using only the
// version-matched wasm32 configuration headers prepared by the PDO builder.
const scratch = await mkdtemp(path.join(cache, 'fileinfo-source-'));
try {
  execFileSync('tar', ['--extract', '--xz', '--file', path.join(cache, `php-${version.patchVersion}.tar.xz`),
    '--directory', scratch, '--no-same-owner', `php-${version.patchVersion}/ext/fileinfo`]);
  const extensionSource = path.join(scratch, `php-${version.patchVersion}/ext/fileinfo`);
  const configuration = await readFile(path.join(extensionSource, 'config.m4'), 'utf8');
  const sources = ['fileinfo.c', 'php_libmagic.c', ...new Set(configuration.match(/libmagic\/[a-z_]+\.c/g))];
  if (sources.length < 20 || !sources.includes('libmagic/strcasestr.c')) throw new Error('Review the changed fileinfo build inputs.');
  const flags = ['-O3', '-flto', '-sSIDE_MODULE=1', '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASYNCIFY_IMPORTS=*',
    '-DCOMPILE_DL_FILEINFO=1', '-DZEND_ENABLE_STATIC_TSRMLS_CACHE=1'];
  const includes = [source, ...['main', 'Zend', 'TSRM', 'ext'].map(name => path.join(source, name)),
    extensionSource, path.join(extensionSource, 'libmagic')].map(directory => `-I${directory}`);
  await mkdir(output, { recursive: true });
  const basename = `php${minor}-fileinfo`;
  execFileSync('emcc', [...flags, ...includes, ...sources.map(name => path.join(extensionSource, name)),
    '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
  const licenses = [];
  for (const [filename, sourceFile] of [
    [`${basename}.LICENSE.php`, path.join(source, 'LICENSE')],
    [`${basename}.LICENSE.libmagic`, path.join(extensionSource, 'libmagic/LICENSE')],
  ]) {
    await cp(sourceFile, path.join(output, filename));
    licenses.push({ file: filename, sha256: await hashFile(sourceFile) });
  }
  const noticeFile = `${basename}.NOTICES`;
  const notices = [];
  for (const filename of sources) {
    const contents = await readFile(path.join(extensionSource, filename), 'utf8');
    const notice = contents.match(/^(?:\/\*[\s\S]*?\*\/\s*)+/)?.[0];
    if (notice) notices.push(`${filename}\n${notice.trim()}`);
  }
  await writeFile(path.join(output, noticeFile), `${notices.join('\n\n')}\n`);
  licenses.push({ file: noticeFile, sha256: await hashFile(path.join(output, noticeFile)) });
  const provenance = {
    schemaVersion: 1, name: 'fileinfo', phpMinor: minor, phpVersion: version.patchVersion,
    upstream: { repository: pins.upstream.repository, commit: pins.upstream.commit, runtimeVersion: pins.upstream.version },
    emscriptenVersion: compilerVersion,
    phpSource: { url: `https://www.php.net/distributions/php-${version.patchVersion}.tar.xz`, sha256: version.sourceSha256 },
    buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)),
    sources, sourceInventory: await inventory(extensionSource), flags,
    magicDatabase: { embedded: true, source: 'ext/fileinfo/data_file.c', sha256: await hashFile(path.join(extensionSource, 'data_file.c')) },
    licenses, extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
  };
  await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Built ${path.join(output, `${basename}.so`)} from pinned PHP source; magic database embedded.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
