import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizePhpSettings, phpIni, phpRequestBodyLimit, runtimeHealthSource, runtimeRandomValue, assertRuntimeHealth } from '../src/php-settings.mjs';
import { configurePhpRouting } from '../src/php-routing.mjs';
import { installPhpRecovery } from '../src/php-recovery.mjs';
import { applyJcbRuntimeCompatibility } from '../src/jcb-compatibility.mjs';
import { createPhpFetch } from '../src/php-network.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Run the verified upstream PHP binary and staged CGI adapter for build tasks. */
export async function createNodeRuntime({ directory = process.env.PLAYGROUND_DIST || path.join(root, 'dist'), phpVersion, database = 'joomla', phpSettings: requestedPhpSettings } = {}) {
  const phpSettings = normalizePhpSettings(requestedPhpSettings);
  const bodyLimit = phpRequestBodyLimit(phpSettings);
  const distribution = path.resolve(directory);
  const manifestPath = path.join(distribution, 'assets/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = manifest.php.find((item) => item.version === (phpVersion ?? manifest.defaults.phpVersion));
  if (!entry) throw new Error(`The built catalog does not contain PHP ${phpVersion}.`);
  const assetURL = (value) => new URL(value, pathToFileURL(manifestPath));
  const moduleURL = new URL('./PhpCgiNode.mjs', assetURL(entry.moduleUrl));
  const [{ PhpCgiNode }, { createMariaDB }, { createPhpWasmAdapter }] = await Promise.all([
    import(moduleURL.href), import(assetURL(manifest.bridge.moduleUrl).href), import(assetURL(manifest.bridge.adapterUrl).href),
  ]);
  const databaseRuntime = await createMariaDB({ database, timeoutMs: 120_000 });
  let php;
  let binary;
  let queue = Promise.resolve();
  let closed = false;
  let closing = false;
  let failed;
  let closePromise;
  let requestActive = false;
  const originalFetch = globalThis.fetch;
  const headersSet = new Set();
  const prefix = `/__site/build/${randomUUID()}/`;
  const baseUrl = `http://localhost${prefix}`;
  const assetBaseUrl = manifest.deployment?.canonicalUrl || 'https://playground.joomengine.org/';
  const enqueue = (operation) => {
    if (closing) return Promise.reject(new Error('The Node playground runtime is closing.'));
    const result = queue.then(() => {
      if (closed || failed) throw failed || new Error('The Node playground runtime is closed.');
      return operation();
    });
    queue = result.catch(() => {});
    return result;
  };
  const virtualPath = (value) => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.includes('\\') || value.split('/').includes('..')) {
      throw new TypeError('A virtual filesystem path must be absolute and must not traverse directories.');
    }
    return value;
  };
  const exists = (filename) => binary.FS.analyzePath(virtualPath(filename)).exists;
  const fs = {
    async mkdir(filename) { binary.FS.mkdirTree(virtualPath(filename)); },
    async writeFile(filename, data) {
      binary.FS.writeFile(virtualPath(filename), data instanceof ArrayBuffer ? new Uint8Array(data) : data,
        typeof data === 'string' ? { encoding: 'utf8' } : undefined);
    },
    async readFile(filename, options = {}) { return binary.FS.readFile(virtualPath(filename), options.encoding === 'utf8' ? { encoding: 'utf8' } : { encoding: 'binary' }); },
    async readdir(filename) { return binary.FS.readdir(virtualPath(filename)).filter((name) => !['.', '..'].includes(name)); },
    async stat(filename) {
      if (!exists(filename)) return null;
      const info = binary.FS.stat(filename);
      return { size: info.size, mode: info.mode, mtime: info.mtime.toISOString(), isDirectory: binary.FS.isDir(info.mode), isFile: binary.FS.isFile(info.mode) };
    },
    async unlink(filename) { binary.FS.unlink(virtualPath(filename)); },
  };
  const request = async (pathname = '/', init = {}) => {
    const url = new URL(String(pathname).replace(/^\/+/, ''), baseUrl);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith(prefix)) throw new TypeError('The request must stay within the build site.');
    const input = new Request(url, { ...init, redirect: 'manual' });
    const inputBody = input.body ? new Uint8Array(await input.arrayBuffer()) : null;
    if (inputBody?.byteLength > bodyLimit) throw new RangeError(`The HTTP request exceeds post_max_size (${phpSettings.post_max_size}).`);
    if (inputBody?.byteLength && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)) throw new TypeError(`Request bodies are not supported for ${input.method}.`);
    for (const name of headersSet) php.env[name] = '';
    headersSet.clear();
    for (const [name, value] of input.headers) {
      if (['cookie', 'host', 'content-length', 'content-type'].includes(name)) continue;
      const environmentName = `HTTP_${name.toUpperCase().replaceAll('-', '_')}`;
      php.env[environmentName] = value;
      headersSet.add(environmentName);
    }
    const headers = new Map(input.headers);
    headers.set('host', 'localhost');
    if (input.headers.has('content-type')) headers.set('Content-Type', input.headers.get('content-type'));
    php.error = [];
    const original = php.binary;
    applyJcbRuntimeCompatibility(binary, php.docroot);
    requestActive = true;
    try {
      let response = await php.request({ url: `${url.pathname}${url.search}`, method: input.method, headers, body: inputBody ? new Blob([inputBody]).stream() : null });
      if (php.binary !== original) {
        try { await php.binary; }
        catch (error) {
          const detail = response instanceof Response ? (await response.clone().text()).slice(0, 2000) : '';
          failed = new Error(`PHP could not recover after an application error: ${error.message}.${detail ? ` Original response: ${detail}` : ''}`);
          throw failed;
        }
        if (response instanceof Response && response.status < 400) response = new Response(response.body, { status: 500, headers: response.headers });
      }
      if (!(response instanceof Response)) throw new Error('The upstream PHP runtime did not return a response.');
      const diagnostics = new TextDecoder().decode(new Uint8Array(php.error || [])).trim();
      if (diagnostics) console.warn(`[PHP ${entry.version}] ${diagnostics.slice(0, 8000)}`);
      return response;
    } finally {
      requestActive = false;
      await databaseRuntime.reset();
    }
  };
  const runPhp = async (source) => {
    if (typeof source !== 'string') throw new TypeError('PHP source must be a string.');
    const filename = `operation-${randomUUID()}.php`;
    const target = `/internal/${filename}`;
    binary.FS.writeFile(target, source, { encoding: 'utf8' });
    const previous = php.docroot;
    php.docroot = '/internal';
    try {
      const response = await request(filename);
      const body = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, statusText: response.statusText, headers: [...response.headers], body, text: new TextDecoder().decode(body) };
    } finally {
      php.docroot = previous;
      if (exists(target)) binary.FS.unlink(target);
    }
  };
  const fetchAsset = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value, assetBaseUrl);
    if (url.origin !== new URL(assetBaseUrl).origin) return fetch(value, init);
    const basePath = new URL(assetBaseUrl).pathname;
    if (!url.pathname.startsWith(basePath)) throw new Error('Build asset URL leaves the deployment path.');
    const relative = decodeURIComponent(url.pathname.slice(basePath.length));
    const filename = path.resolve(distribution, relative);
    if (!filename.startsWith(`${distribution}${path.sep}`)) throw new Error('Build asset URL leaves the distribution.');
    try { return new Response(await readFile(filename)); }
    catch (error) {
      if (error.code === 'ENOENT') return new Response('Build asset not found', { status: 404 });
      throw error;
    }
  };
  const sourceLoader = async (name) => {
    if (!/^[a-z-]+$/.test(name)) throw new TypeError('Invalid Joomla provisioning script name.');
    return readFile(path.join(distribution, 'src/joomla/php', `${name}.php`), 'utf8');
  };
  const raw = {
    url: baseUrl, baseUrl, assetBaseUrl, manifest, phpVersion: entry.version, phpSettings,
    documentRoot: '/persist/www', installMarkerPath: '/persist/meta/joomla-install.json',
    fs, request, runPhp, fetchAsset, sourceLoader, async flush() { await databaseRuntime.flush(); },
  };
  const handle = {
    ...raw,
    fs: Object.fromEntries(Object.entries(fs).map(([name, operation]) => [name, (...args) => enqueue(() => operation(...args))])),
    request: (...args) => enqueue(() => request(...args)),
    runPhp: (...args) => enqueue(() => runPhp(...args)),
    flush: () => enqueue(() => raw.flush()),
    withExclusive: (callback) => enqueue(() => callback(raw)),
    exportSite: (options) => enqueue(async () => {
      const { exportSite } = await import(pathToFileURL(path.join(distribution, 'src/export.mjs')));
      return exportSite(raw, options, { sourceLoader: () => readFile(path.join(distribution, 'src/export/site.php'), 'utf8') });
    }),
    close() {
      closing = true;
      return closePromise ??= (async () => {
        await queue;
        closed = true;
        try { await databaseRuntime.close(); } finally {
          php = null; binary = null;
          globalThis.fetch = originalFetch;
        }
      })();
    },
  };
  try {
    // This runtime owns its worker's fetch function. Install the same recursive
    // request guard as the browser here, where native cURL actually runs.
    globalThis.fetch = createPhpFetch(originalFetch.bind(globalThis), baseUrl, () => requestActive);
    const adapter = createPhpWasmAdapter(databaseRuntime.hostCalls, { shimUrl: new URL('./php-wasm.php', assetURL(manifest.bridge.adapterUrl)) });
    php = new PhpCgiNode({
      ...adapter, phpArgs: { ...adapter.phpArgs, getRandomValue: runtimeRandomValue }, version: entry.version, prefix, docroot: raw.documentRoot, persist: [], staticFS: true, autoTransaction: false,
      sharedLibs: entry.sharedLibs.map((library) => ({ ...library, url: assetURL(library.url).href })),
      files: [...(entry.files || []).map((file) => ({ ...file, url: assetURL(file.url).href })), ...adapter.files,
        { parent: '/internal', name: 'rocket-http.php', url: new URL('../src/php-http-stream.php', import.meta.url).href }],
      ini: `${adapter.ini}${phpIni(phpSettings)}\nauto_prepend_file=/internal/rocket-http.php\n`,
    });
    binary = await php.binary;
    configurePhpRouting(php, binary);
    for (const directory of ['/persist/www', '/persist/sessions', '/persist/meta', '/config', '/internal']) binary.FS.mkdirTree(directory);
    installPhpRecovery(php, {
      currentBinary: () => binary,
      prepare: next => {
        for (const directory of ['/persist/www', '/persist/sessions', '/persist/meta', '/config', '/internal']) next.FS.mkdirTree(directory);
      },
      restored: next => { binary = next; configurePhpRouting(php, binary); },
    });
    php.initialized = true;
    php.staticCacheTime = 0;
    php.dynamicCacheTime = 0;
    const result = await handle.runPhp(runtimeHealthSource());
    const identity = JSON.parse(result.text);
    if (!identity.extensions.includes('pdo_mariadb_wasm') || !identity.pdoDrivers.includes('mysql') || identity.phpVersion !== entry.patchVersion) throw new Error(`Build runtime identity differs from its manifest: ${result.text}`);
    handle.runtimeInfo = assertRuntimeHealth(identity, phpSettings);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
