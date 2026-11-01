import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeBuildContext, nativeProvenance, preparePhpNativeSource, nativeRoot as root } from './native-runtime.mjs';
import { downloadVerified, hashFile, inventory } from './assets.mjs';
import { sodiumSource } from './sodium.mjs';

const context = await nativeBuildContext(process.argv[2]);
const { version } = context;
const minor = version.version;
const source = await preparePhpNativeSource(version);
const cache = path.dirname(source);
const output = path.resolve(root, process.argv[3] || '.cache/sodium');
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
  const extensionSource = path.join(scratch, 'php-sodium');
  await cp(path.join(source, 'ext/sodium'), extensionSource, { recursive: true });
  const sources = ['libsodium.c', 'sodium_pwhash.c'];
  const configuration = await readFile(path.join(extensionSource, 'config.m4'), 'utf8');
  for (const filename of sources) if (!configuration.includes(filename)) throw new Error('Review the changed sodium extension source list.');
  const flags = [...context.flags, '-DCOMPILE_DL_SODIUM=1', '-DHAVE_LIBSODIUMLIB=1', '-Wno-type-limits'];
  const includes = [path.join(prefix, 'include'), ...context.includes, extensionSource].map(directory => `-I${directory}`);
  await mkdir(output, { recursive: true });
  const basename = `php${minor}-sodium`;
  execFileSync('emcc', [...flags, ...includes, ...sources.map(name => path.join(extensionSource, name)),
    path.join(prefix, 'lib/libsodium.a'), '-o', path.join(output, `${basename}.so`)], { stdio: 'inherit' });
  const licenses = [];
  for (const [name, filename] of [['LICENSE.php', path.join(source, 'LICENSE')], ['LICENSE.libsodium', path.join(librarySource, 'LICENSE')]]) {
    const file = `${basename}.${name}`;
    await cp(filename, path.join(output, file));
    licenses.push({ file, sha256: await hashFile(filename) });
  }
  const provenance = {
    schemaVersion: 1, name: 'sodium', ...nativeProvenance(context),
    sodiumSource, buildScriptSha256: await hashFile(fileURLToPath(import.meta.url)),
    sources, phpSourceInventory: await inventory(extensionSource), sodiumSourceInventory,
    flags, libraryFlags, configureFlags, licenses,
    extension: { file: `${basename}.so`, sha256: await hashFile(path.join(output, `${basename}.so`)) },
  };
  await writeFile(path.join(output, `${basename}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Built ${path.join(output, `${basename}.so`)} with libsodium ${sodiumSource.version}.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
