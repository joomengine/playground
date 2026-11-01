import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBuildContext, nativeProvenance, preparePhpNativeSource, nativeRoot as root } from './native-runtime.mjs';
import { downloadVerified, hashFile, inventory } from './assets.mjs';
import { curlSource } from './curl.mjs';

const context = await nativeBuildContext(process.argv[2]);
const { version } = context;
const minor = version.version;
const source = await preparePhpNativeSource(version);
const cache = path.dirname(source);
const output = path.resolve(root, process.argv[3] || '.cache/curl');
const archive = await downloadVerified(curlSource.url, curlSource.sha256,
  path.join(root, '.cache', `php-wasm-curl-${curlSource.commit}.tar.gz`));

// Compile the release-matched patched PHP sources against its installed int64 SDK.
const scratch = await mkdtemp(path.join(cache, 'curl-source-'));
try {
  execFileSync('tar', ['--extract', '--gzip', '--file', archive, '--directory', scratch, '--no-same-owner']);
  const librarySource = path.join(scratch, `php-wasm-curl-${curlSource.commit}`);
  const curlSourceInventory = await inventory(librarySource);
  const extensionSource = path.join(scratch, 'php-curl');
  await cp(path.join(source, 'ext/curl'), extensionSource, { recursive: true });
  const configuration = await readFile(path.join(extensionSource, 'config.m4'), 'utf8');
  const sources = ['interface.c', 'multi.c', 'share.c', 'curl_file.c'];
  if (!configuration.includes(sources.join(' '))) throw new Error('Review the changed curl extension build inputs.');
  const httpSource = path.join(root, 'native/http-stream.c');
  const interfacePath = path.join(extensionSource, 'interface.c');
  const originalInterfaceSha256 = await hashFile(interfacePath);
  const originalInterface = await readFile(interfacePath, 'utf8');
  const moduleSlot = '\tPHP_MSHUTDOWN(curl),\n\tNULL,\n\tNULL,\n\tPHP_MINFO(curl),';
  const moduleDeclaration = 'zend_module_entry curl_module_entry = {';
  if (originalInterface.split(moduleSlot).length !== 2 || originalInterface.split(moduleDeclaration).length !== 2) {
    throw new Error('Review the changed cURL request initialization interface.');
  }
  await writeFile(interfacePath, originalInterface
    .replace(moduleDeclaration, `PHP_RINIT_FUNCTION(curl_rocket_http);\n\n${moduleDeclaration}`)
    .replace(moduleSlot, '\tPHP_MSHUTDOWN(curl),\n\tPHP_RINIT(curl_rocket_http),\n\tNULL,\n\tPHP_MINFO(curl),'));
  const httpStreams = { sourceSha256: await hashFile(httpSource), originalInterfaceSha256,
    interfaceSha256: await hashFile(interfacePath) };
  // The upstream Makefile keeps EM_JS objects out of LTO so their JavaScript
  // bodies remain available to the published runtime's dynamic module loader.
  execFileSync('make', ['-j2', 'CFLAGS=-O3 -flto'], { cwd: librarySource, stdio: 'inherit' });
  const flags = [...context.flags, '-flto', '-DCOMPILE_DL_CURL=1', '-DHAVE_CURL=1', '-DCURL_DISABLE_TYPECHECK'];
  const includes = [path.join(librarySource, 'include'), ...context.includes, extensionSource]
    .map(directory => `-I${directory}`);
  await mkdir(output, { recursive: true });
  const basename = `php${minor}-curl`;
  execFileSync('emcc', [...flags, ...includes, ...sources.map(name => path.join(extensionSource, name)), httpSource,
    '-Wl,--whole-archive', path.join(librarySource, 'build/libcurl.a'), '-Wl,--no-whole-archive',
    '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
  const licenses = [];
  for (const [name, filename] of [
    ['LICENSE.php', path.join(source, 'LICENSE')],
    ...['LICENSE', 'LICENSE-GPL', 'COPYING.curl', 'NOTICE'].map(name => [name, path.join(librarySource, name)]),
  ]) {
    const file = `${basename}.${name}`;
    await cp(filename, path.join(output, file));
    licenses.push({ file, sha256: await hashFile(filename) });
  }
  const provenance = {
    schemaVersion: 1, name: 'curl', ...nativeProvenance(context),
    curlSource, buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)),
    sources, phpSourceInventory: await inventory(extensionSource), curlSourceInventory, httpStreams, flags,
    licenses, extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
  };
  await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Built ${path.join(output, `${basename}.so`)} from pinned PHP and upstream fetch-backed curl sources.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
