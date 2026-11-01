import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPhpRuntime } from '../scripts/php-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const distribution = path.resolve(root, process.env.PLAYGROUND_DIST || 'dist');
const manifestPath = path.join(distribution, 'assets/manifest.json');
let releasePromise, buildPromise;
const libraries = new Map();

/** Use the already selected release; tests must never independently resolve latest. */
export function runtimeConfiguration() {
  return releasePromise ??= readFile(path.join(root, 'versions.json'), 'utf8')
    .then(JSON.parse).then(versions => loadPhpRuntime({ root, versions }));
}

export function builtManifest() {
  return buildPromise ??= readFile(manifestPath, 'utf8').then(JSON.parse);
}

export async function releasedWrapper(minor, packageName, wrapper) {
  const entry = (await runtimeConfiguration()).php.find(value => value.version === minor);
  if (!entry) throw new Error(`Selected int64 release does not contain PHP ${minor}.`);
  return import(pathToFileURL(path.join(entry.runtimeDirectory, 'packages', packageName, `${wrapper}.mjs`)).href);
}

/** Load the release's matching support libraries, as the production builder does. */
export function releasedLibraries(minor) {
  if (!libraries.has(minor)) libraries.set(minor, (async () => {
    const entry = (await runtimeConfiguration()).php.find(value => value.version === minor);
    if (!entry) throw new Error(`Selected int64 release does not contain PHP ${minor}.`);
    const packages = ['zlib', 'libxml', 'xml', 'dom', 'simplexml', 'xmlreader', 'xmlwriter',
      'iconv', 'mbstring', 'intl', 'libzip', 'gd', 'openssl', 'phar', 'sqlite'];
    return Promise.all(packages.map(async name => (await import(pathToFileURL(
      path.join(entry.runtimeDirectory, 'packages', name, 'index.mjs')).href)).default));
  })());
  return libraries.get(minor);
}

/** Exercise the exact staged CGI/debugger adapter used by the production build. */
export async function builtWrapper(minor, mode = 'cgi') {
  const entry = (await builtManifest()).php.find(value => value.version === minor);
  if (!entry) throw new Error(`Built distribution does not contain PHP ${minor}.`);
  const module = mode === 'debugger' ? entry.debugger.moduleUrl : entry.moduleUrl;
  const wrapper = mode === 'debugger' ? 'PhpDbgNode.mjs' : 'PhpCgiNode.mjs';
  return import(new URL(wrapper, new URL(module, pathToFileURL(manifestPath))).href);
}
