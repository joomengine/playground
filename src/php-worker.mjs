import { MAX_BODY_BYTES, serializeResponse } from './http.mjs';
import { normalizePhpSettings, phpIni, phpRequestBodyLimit, runtimeHealthSource, runtimeRandomValue, assertRuntimeHealth } from './php-settings.mjs';
import { checkpointSource, restoreCheckpointSource } from './checkpoint-program.mjs';
import { configurePhpRouting } from './php-routing.mjs';
import { createPhpFetch } from './php-network.mjs';
import { installPhpRecovery } from './php-recovery.mjs';
import { applyJcbRuntimeCompatibility } from './jcb-compatibility.mjs';
import { staticAssetResponse } from './static-assets.mjs';

const MAX_OPERATIONS = 64;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const databaseCalls = new Map();
const forwardedHeaders = new Set();
let nextDatabaseId = 0;
let queue = Promise.resolve();
let queued = 0;
let php;
let binary;
let persistent = false;
let readOnly = false;
let recoveryCookies = null;
let terminal = false;
let routePrefix;
let mountPath;
let phpSettings;
let requestBodyLimit = MAX_BODY_BYTES;
let requestActive = false;
let issuedDatabaseCalls = 0;

class FatalRuntimeError extends Error {
  fatal = true;
}

function databaseCall(payload) {
  if (terminal) return Promise.reject(new Error('The PHP worker is closed.'));
  if (typeof payload !== 'string') return Promise.reject(new TypeError('Database payload must be a string.'));
  const id = `database-${++nextDatabaseId}`;
  issuedDatabaseCalls++;
  return new Promise((resolve, reject) => {
    databaseCalls.set(id, { resolve, reject });
    self.postMessage({ type: 'database-call', id, payload });
  });
}

function virtualPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) {
    throw new TypeError('A filesystem path must be absolute and stay within the virtual filesystem.');
  }
  return path;
}

function mkdir(path) { binary.FS.mkdirTree(virtualPath(path)); }
function exists(path) { return binary.FS.analyzePath(path).exists; }

function removeTree(path) {
  const stat = binary.FS.lstat(path);
  if (binary.FS.isDir(stat.mode)) {
    for (const name of binary.FS.readdir(path)) {
      if (name !== '.' && name !== '..') removeTree(`${path}/${name}`);
    }
    binary.FS.rmdir(path);
  } else binary.FS.unlink(path);
}

async function flush() {
  if (persistent && binary && !readOnly) {
    await new Promise((resolve, reject) => binary.FS.syncfs(false, (error) => error ? reject(error) : resolve()));
  }
}

function restoreRecoveryCookies() {
  if (!readOnly) return;
  // Upstream rewrites this file after every CGI request, even with staticFS.
  // Recovery downloads must contain the original saved cookie file verbatim.
  const path = '/config/.cookies';
  if (recoveryCookies) {
    if (exists(path)) binary.FS.chmod(path, recoveryCookies.mode | 0o200);
    binary.FS.writeFile(path, recoveryCookies.bytes);
    binary.FS.chmod(path, recoveryCookies.mode);
    binary.FS.utime(path, recoveryCookies.atime, recoveryCookies.mtime);
  } else if (exists(path)) binary.FS.unlink(path);
}

function clearHeaders() {
  for (const name of forwardedHeaders) php.env[name] = '';
  forwardedHeaders.clear();
}

async function request(value) {
  try { return await requestResponse(value); }
  finally {
    if (readOnly && binary) {
      // A failed CGI request may have replaced the PHP module asynchronously.
      await php.binary;
      restoreRecoveryCookies();
    }
  }
}

async function requestResponse(value) {
  if (!value || typeof value.url !== 'string') throw new TypeError('A serialized HTTP request is required.');
  const url = new URL(value.url, self.location.href);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(routePrefix)) {
    throw new TypeError('The HTTP request must target this playground site.');
  }
  const method = String(value.method || 'GET').toUpperCase();
  const body = value.body == null ? null : value.body instanceof Uint8Array ? value.body : new Uint8Array(value.body);
  if (body?.byteLength > requestBodyLimit) throw new RangeError(`The HTTP request exceeds post_max_size (${phpSettings.post_max_size}).`);
  if (body?.byteLength && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new TypeError(`Request bodies are not supported for ${method}.`);
  const headers = new Headers(value.headers || []);
  clearHeaders();
  for (const [name, content] of headers) {
    if (['cookie', 'host', 'content-length', 'content-type'].includes(name)) continue;
    const environmentName = `HTTP_${name.toUpperCase().replaceAll('-', '_')}`;
    php.env[environmentName] = content;
    forwardedHeaders.add(environmentName);
  }
  php.error = [];
  const captured = php.binary;
  const executionsBeforeRequest = php.count;
  const callsBeforeRequest = issuedDatabaseCalls;
  let recoveryMessage = '';
  if (!readOnly) applyJcbRuntimeCompatibility(binary, php.docroot);
  let response;
  requestActive = true;
  try {
    response = await php.request(new Request(url, {
      method, headers, body: ['GET', 'HEAD'].includes(method) ? null : body, redirect: 'manual',
    }));
  } finally { requestActive = false; }
  if (php.binary !== captured) {
    try { await php.binary; }
    catch (error) {
      const details = response instanceof Response ? (await response.clone().text()).slice(0, 2000) : '';
      throw new FatalRuntimeError(`PHP could not recover after an application error: ${error.message}.${details ? ` Original response: ${details}` : ''}`);
    }
    recoveryMessage = 'PHP restarted after an application error. The original response is preserved; the request was not replayed.';
    console.warn(recoveryMessage);
    if (response instanceof Response && response.status < 400) response = new Response(response.body, { status: 500, headers: response.headers });
  }
  const diagnostics = new TextDecoder().decode(new Uint8Array(php.error || [])).trim();
  if (diagnostics) console.warn(`[PHP ${php.phpVersion}] ${diagnostics.slice(0, 8000)}`);
  const serialized = await staticAssetResponse(await serializeResponse(response), value, {
    staticAsset: php.binary === captured && php.count === executionsBeforeRequest && response.headers.has('x-php-wasm-cache-time'),
  });
  return { ...serialized, databaseUsed: issuedDatabaseCalls !== callsBeforeRequest,
    diagnostic: [recoveryMessage, diagnostics ? `[PHP ${php.phpVersion}] ${diagnostics.slice(0, 8000)}` : ''].filter(Boolean).join('\n') || undefined };
}

async function runPhp(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
    throw new TypeError('PHP source must be a string no larger than 8 MiB.');
  }
  const filename = `operation-${crypto.randomUUID()}.php`;
  const path = `/internal/${filename}`;
  const documentRoot = php.docroot;
  binary.FS.writeFile(path, source, { encoding: 'utf8' });
  php.docroot = '/internal';
  try {
    const response = await request({ url: new URL(`${routePrefix}${filename}`, self.location.origin).href, method: 'GET', headers: [] });
    return { ...response, text: new TextDecoder().decode(response.body) };
  } finally {
    php.docroot = documentRoot;
    if (exists(path)) binary.FS.unlink(path);
  }
}

async function initialize(args) {
  if (php) throw new Error('The PHP worker has already been initialized.');
  if (!args || typeof args.moduleUrl !== 'string' || typeof args.adapterUrl !== 'string') throw new TypeError('PHP runtime and adapter URLs are required.');
  const moduleURL = new URL(args.moduleUrl, self.location.href);
  const adapterURL = new URL(args.adapterUrl, self.location.href);
  if (moduleURL.origin !== self.location.origin || adapterURL.origin !== self.location.origin) throw new TypeError('PHP runtime assets must be hosted with the playground.');
  if (typeof args.prefix !== 'string' || !args.prefix.startsWith('/') || args.prefix.startsWith('//') || /[?#\\\0]/.test(args.prefix)) {
    throw new TypeError('The site route prefix must be an absolute URL path.');
  }
  routePrefix = `${args.prefix.replace(/\/+$/, '')}/`;
  globalThis.fetch = createPhpFetch(globalThis.fetch.bind(globalThis),
    new URL(routePrefix, self.location.origin), () => requestActive);
  phpSettings = normalizePhpSettings(args.phpSettings);
  requestBodyLimit = phpRequestBodyLimit(phpSettings);
  persistent = args.persistence === true;
  readOnly = args.readOnly === true;
  if (readOnly && !persistent) throw new TypeError('Read-only recovery requires saved browser storage.');
  mountPath = args.mountPath;
  if (persistent && (typeof mountPath !== 'string' || !/^\/[a-zA-Z0-9_-]+$/.test(mountPath) || ['/persist', '/config', '/internal', '/tmp'].includes(mountPath))) {
    throw new TypeError('Persistent storage requires a unique top-level mount path.');
  }
  // Site files follow our explicit filesystem persistence policy, including temporary sites.
  Object.defineProperty(globalThis, 'caches', { value: undefined, configurable: true });
  const [{ PhpCgiWorker }, { createPhpWasmAdapter }] = await Promise.all([import(moduleURL.href), import(adapterURL.href)]);
  const adapter = createPhpWasmAdapter({ 'mariadb.v1': databaseCall });
  php = new PhpCgiWorker({
    ...adapter,
    phpArgs: { ...adapter.phpArgs, getRandomValue: runtimeRandomValue },
    version: args.phpVersion,
    prefix: routePrefix,
    docroot: '/persist/www',
    persist: persistent ? [{ mountPath }] : [],
    sharedLibs: args.sharedLibs || [],
    files: [...(args.files || []), ...adapter.files,
      { parent: '/internal', name: 'rocket-http.php', url: new URL('./php-http-stream.php', import.meta.url).href }],
    // Provisioning commits both stores once before the site becomes available.
    staticFS: true,
    autoTransaction: false,
    ini: `${adapter.ini}${phpIni(phpSettings)}\nauto_prepend_file=/internal/rocket-http.php\n`,
    types: {
      css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
      woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', txt: 'text/plain; charset=utf-8',
      html: 'text/html; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf', wasm: 'application/wasm',
    },
  });
  const prepareFilesystem = current => {
    const fs = current.FS;
    if (persistent) {
      fs.mkdirTree(`${mountPath}/data`);
      fs.mkdirTree(`${mountPath}/config`);
      for (const [name, destination] of [['/persist', `${mountPath}/data`], ['/config', `${mountPath}/config`]]) {
        if (fs.analyzePath(name).exists) throw new Error(`The PHP runtime unexpectedly created ${name} before storage initialization.`);
        fs.symlink(destination, name);
      }
    } else {
      fs.mkdirTree('/persist');
      fs.mkdirTree('/config');
    }
    for (const path of ['/persist/www', '/persist/sessions', '/persist/meta', '/internal']) fs.mkdirTree(path);
  };
  binary = await php.binary;
  prepareFilesystem(binary);
  if (readOnly && exists('/config/.cookies')) {
    const { mode, atime, mtime } = binary.FS.stat('/config/.cookies');
    recoveryCookies = { bytes: binary.FS.readFile('/config/.cookies', { encoding: 'binary' }), mode, atime, mtime };
  }
  configurePhpRouting(php, binary);
  installPhpRecovery(php, {
    currentBinary: () => binary,
    prepare: prepareFilesystem,
    beforeRefresh: flush,
    // Persisted files are hydrated by upstream; temporary sites must copy their files.
    roots: persistent ? ['/tmp', '/internal'] : ['/persist', '/config', '/tmp', '/internal'],
    restored: next => { binary = next; configurePhpRouting(php, binary); },
  });
  if (exists('/config/.cookies')) php.cookieJar.load(binary.FS.readFile('/config/.cookies', { encoding: 'utf8' }));
  php.initialized = true;
  php.staticCacheTime = 0;
  php.dynamicCacheTime = 0;
  const health = await runPhp(runtimeHealthSource());
  let result;
  try { result = JSON.parse(health.text); }
  catch { throw new FatalRuntimeError(`PHP initialization did not return valid runtime metadata: ${health.text.slice(0, 2000)}`); }
  if (!result.pdoDrivers?.includes('mysql') || !result.extensions?.includes('pdo_mariadb_wasm')) {
    throw new FatalRuntimeError('The PHP runtime did not load the MariaDB PDO extension.');
  }
  return assertRuntimeHealth(result, phpSettings);
}

function filesystem(operation, args) {
  const path = virtualPath(args.path);
  if (readOnly && ['mkdir', 'writeFile', 'unlink'].includes(operation)) throw new Error('Saved files cannot be modified in read-only recovery.');
  switch (operation) {
    case 'mkdir': mkdir(path); return null;
    case 'writeFile': {
      const data = args.data;
      if (typeof data !== 'string' && !(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) throw new TypeError('File contents must be text or bytes.');
      binary.FS.writeFile(path, data instanceof ArrayBuffer ? new Uint8Array(data) : data, typeof data === 'string' ? { encoding: 'utf8' } : undefined);
      return null;
    }
    case 'readFile': return binary.FS.readFile(path, args.options?.encoding === 'utf8' || args.data?.encoding === 'utf8' || args.encoding === 'utf8' ? { encoding: 'utf8' } : { encoding: 'binary' });
    case 'readdir': return binary.FS.readdir(path).filter((name) => name !== '.' && name !== '..');
    case 'stat': {
      if (!exists(path)) return null;
      const stat = binary.FS.stat(path);
      return { size: stat.size, mode: stat.mode, mtime: stat.mtime.toISOString(), isDirectory: binary.FS.isDir(stat.mode), isFile: binary.FS.isFile(stat.mode) };
    }
    case 'unlink': binary.FS.unlink(path); return null;
    default: throw new TypeError(`Unknown filesystem operation: ${operation}`);
  }
}

async function operation(name, args = {}) {
  if (terminal) throw new FatalRuntimeError('The PHP worker is closed.');
  if (name === 'initialize') return initialize(args);
  if (!php || !binary) throw new Error('Initialize PHP before using the worker.');
  if (name.startsWith('fs.')) return filesystem(name.slice(3), args);
  switch (name) {
    case 'request': return request(args);
    case 'runPhp': return runPhp(args.source ?? args.code);
    case 'flush': await flush(); return null;
    case 'enablePersistence': php.phpArgs.staticFS = !persistent || readOnly; return null;
    case 'checkpoint': {
      if (!readOnly) binary.FS.writeFile('/config/.cookies', php.cookieJar.dump());
      await flush();
      const archive = `/tmp/rocket-checkpoint-${crypto.randomUUID()}.zip`;
      try {
        const response = await runPhp(checkpointSource(archive, { filesOnlyRecovery: readOnly }));
        const result = JSON.parse(response.text);
        if (response.status !== 200 || result.ok !== true) throw new Error('The private runtime checkpoint failed.');
        return binary.FS.readFile(archive, { encoding: 'binary' });
      } finally { if (exists(archive)) binary.FS.unlink(archive); }
    }
    case 'restoreCheckpoint': {
      if (readOnly) throw new Error('Saved files cannot be replaced in read-only recovery.');
      const bytes = args.bytes instanceof Uint8Array ? args.bytes : args.bytes instanceof ArrayBuffer ? new Uint8Array(args.bytes) : null;
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 512 * 1024 * 1024) throw new RangeError('The private runtime checkpoint must contain at most 512 MiB.');
      const archive = `/tmp/rocket-checkpoint-${crypto.randomUUID()}.zip`;
      binary.FS.writeFile(archive, bytes);
      try {
        const response = await runPhp(restoreCheckpointSource(archive));
        const result = JSON.parse(response.text);
        if (response.status !== 200 || result.ok !== true) throw new Error('The private runtime checkpoint could not be restored.');
        php.cookieJar.cookies.clear();
        if (typeof result.restoredCookies === 'string') php.cookieJar.load(result.restoredCookies);
        binary.FS.writeFile('/config/.cookies', php.cookieJar.dump());
        await flush();
        return { ok: true, entries: result.entries };
      } finally { if (exists(archive)) binary.FS.unlink(archive); }
    }
    case 'close': await flush(); terminal = true; return null;
    case 'reset': {
      if (readOnly) throw new Error('Saved files cannot be modified in read-only recovery.');
      for (const root of ['/persist', '/config']) {
        for (const name of binary.FS.readdir(root)) if (name !== '.' && name !== '..') removeTree(`${root}/${name}`);
      }
      php.cookieJar.cookies.clear();
      await flush();
      terminal = true;
      return null;
    }
    default: throw new TypeError(`Unknown PHP operation: ${name}`);
  }
}

self.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type === 'database-result') {
    const pending = databaseCalls.get(message.id);
    if (!pending) return;
    databaseCalls.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(String(message.error)));
    else if (typeof message.value !== 'string') pending.reject(new TypeError('The database returned a non-string response.'));
    else pending.resolve(message.value);
    return;
  }
  if (message?.type !== 'operation' || typeof message.operation !== 'string') return;
  if (queued >= MAX_OPERATIONS) {
    self.postMessage({ type: 'result', id: message.id, error: 'The PHP operation queue is full.', fatal: false });
    return;
  }
  queued++;
  queue = queue.then(async () => {
    try {
      const value = await operation(message.operation, message.args);
      self.postMessage({ type: 'result', id: message.id, value });
    } catch (error) {
      const fatal = error?.fatal === true || message.operation === 'initialize';
      if (fatal) terminal = true;
      self.postMessage({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error), fatal });
    } finally { queued--; }
  });
});
