import { normalizeConfiguration, parseCatalog, normalizeInitialPath } from './config.mjs';
import { installJoomla, inspectJoomla, sha256, importJoomlaSnapshot, restoreJoomlaSession, applyJoomlaConfiguration, discoverJoomlaConfiguration } from './joomla/index.mjs';
import { exportSite } from './export.mjs';
import { serializeRequest, restoreResponse } from './http.mjs';
import { normalizePhpSettings, phpRequestTimeoutMs } from './php-settings.mjs';
import { openStandalone } from './standalone-transfer.mjs';

const base = new URL('../', import.meta.url);
const manifestUrl = new URL('assets/manifest.json', base);
const instances = new Map();
let preparation;
let listenerInstalled = false;

/** Install the routing/isolation worker before collecting user input. */
export function prepareEnvironment() {
  if (preparation) return preparation;
  preparation = (async () => {
    if (!globalThis.isSecureContext || !navigator.serviceWorker) throw new Error('The playground needs HTTPS or localhost and service worker support.');
    if (!navigator.locks || !globalThis.indexedDB) throw new Error('This browser does not provide the storage and locking APIs required by the playground.');
    const registration = await navigator.serviceWorker.register(new URL('service-worker.mjs', base), { type: 'module', scope: base.pathname });
    const active = registration.installing ?? registration.waiting;
    if (active && active.state !== 'activated') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Service worker activation timed out.')), 30_000);
      active.addEventListener('statechange', () => {
        if (active.state === 'activated') { clearTimeout(timer); resolve(); }
        if (active.state === 'redundant') { clearTimeout(timer); reject(new Error('Service worker installation failed.')); }
      });
    });
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The service worker did not take control. Reload this page.')), 30_000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (!listenerInstalled) {
      navigator.serviceWorker.addEventListener('message', receiveSiteRequest);
      listenerInstalled = true;
    }
    return { reloadRequired: !globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function' };
  })().catch(error => { preparation = undefined; throw error; });
  return preparation;
}
async function receiveSiteRequest(event) {
  if (event.source?.scriptURL !== new URL('service-worker.mjs', base).href || event.data?.type !== 'playground-request' || !event.ports[0]) return;
  const port = event.ports[0];
  try {
    const instance = instances.get(event.data.instanceId);
    if (!instance) throw new Error('This playground session is no longer open.');
    port.postMessage(await instance.send('request', event.data.request));
  } catch (error) { port.postMessage({ error: error.message }); }
  finally { port.close(); }
}
async function clientIdentity() {
  const channel = new MessageChannel();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('The service worker did not identify this page.')); }, 10_000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data.clientId); };
    navigator.serviceWorker.controller.postMessage({ type: 'playground-client' }, [channel.port2]);
  });
}

class PhpSession {
  constructor(database, onFailure) {
    this.database = database;
    this.onFailure = onFailure;
    this.worker = new Worker(new URL('./php-worker.mjs', import.meta.url), { type: 'module' });
    this.sequence = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.queued = 0;
    this.failure = null;
    this.worker.addEventListener('error', event => this.fail(new Error(event.message || 'The PHP worker failed.')));
    this.worker.addEventListener('messageerror', () => this.fail(new Error('The PHP worker sent an unreadable message.')));
    this.worker.addEventListener('message', event => this.receive(event.data));
  }
  async receive(message) {
    if (message?.type === 'database-call') {
      try {
        const value = await this.database.hostCalls['mariadb.v1'](message.payload);
        if (!this.failure) this.worker.postMessage({ type: 'database-result', id: message.id, value });
      } catch (error) {
        if (!this.failure) this.worker.postMessage({ type: 'database-result', id: message.id, error: error.message });
      }
      return;
    }
    if (message?.type !== 'result') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.fatal) {
      const error = new Error(message.error || 'PHP stopped unexpectedly.');
      error.code = 'PHP_FAILED';
      await this.fail(error);
      pending.reject(error);
    } else {
      try {
        // Joomla can retain PDO in its container until late PHP shutdown.
        // The completed CGI request is the definitive connection boundary.
        if (['request', 'runPhp'].includes(pending.operation)) await this.database.reset();
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.value);
      } catch (error) { await this.fail(error); pending.reject(error); }
    }
  }
  send(operation, args = {}, timeoutMs = 180_000) {
    if (this.failure) return Promise.reject(this.failure);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 600_000) return Promise.reject(new RangeError('Timeout must be between 10 and 600000 milliseconds.'));
    if (this.queued >= 64) return Promise.reject(new Error('The PHP request queue is full.'));
    this.queued++;
    const result = this.queue.then(() => {
      if (this.failure) throw this.failure;
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error(`PHP ${operation} timed out after ${timeoutMs} ms. Restart the playground; the operation was not replayed.`);
          error.code = 'TIMEOUT';
          this.fail(error);
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer, operation });
        try { this.worker.postMessage({ type: 'operation', id, operation, args }); }
        catch (error) { this.fail(error); }
      });
    }).finally(() => { this.queued--; });
    this.queue = result.catch(() => {});
    return result;
  }
  async flushTogether() {
    const previous = this.queue;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    // Reserve the queue before yielding so no HTTP request can split the two stores' flush.
    this.queue = previous.then(() => held).catch(() => {});
    try {
      await previous;
      if (this.failure) throw this.failure;
      const id = ++this.sequence;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => this.fail(new Error('Saving PHP files timed out.')), 180_000);
        this.pending.set(id, { resolve, reject, timer, operation: 'flush' });
        try { this.worker.postMessage({ type: 'operation', id, operation: 'flush', args: {} }); }
        catch (error) { this.fail(error); }
      });
      await this.database.flush();
    } finally { release(); }
  }
  fail(error) {
    if (this.failure) return this.recovery;
    this.failure = error;
    this.worker.terminate();
    try { this.onFailure?.(error); } catch { /* Cleanup still completes if a UI callback fails. */ }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.recovery = this.database.reset().catch(() => {});
    return this.recovery;
  }
  async close() {
    try { if (!this.failure) await this.send('close'); }
    finally { this.worker.terminate(); this.failure ??= new Error('This PHP session is closed.'); await this.recovery; }
  }
}

async function storageIdentity(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key)) throw new TypeError('Invalid site storage key.');
  return (await sha256(new TextEncoder().encode(`${base.href}\n${key}`))).slice(0, 32);
}
async function acquireSiteLock(identity) {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let acquired, failed;
  const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
  const done = navigator.locks.request(`joomengine-playground:${identity}`, { ifAvailable: true }, async lock => {
    if (!lock) { failed(new Error('This saved site is already open in another tab. Close it there first.')); return; }
    acquired(); await held;
  });
  done.catch(failed);
  await ready;
  return async () => { release(); await done; };
}
async function deleteStore(name) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const timer = setTimeout(() => reject(new Error('Saved storage is still in use. Close other playground tabs and try again.')), 10_000);
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
  });
}
async function eraseStoredSite(identity) {
  await Promise.all([deleteStore(`/joomengine-${identity}`), deleteStore(`/mariadb/idb/joomengine-${identity}`)]);
}
/** Erase a closed or incompletely installed saved site after user confirmation. */
export async function resetPlayground({ storageKey = 'default' } = {}) {
  const identity = await storageIdentity(storageKey);
  const release = await acquireSiteLock(identity);
  try { await eraseStoredSite(identity); } finally { await release(); }
}

/** Create a real Joomla installation backed by upstream PHP and MariaDB WASM. */
export async function createPlayground(input, { onProgress = () => {}, checkpoint = null } = {}) {
  const environment = await prepareEnvironment();
  if (environment.reloadRequired) throw new Error('Reload this page once to activate browser isolation, then start the playground.');
  const progress = value => onProgress({ ...value, phase: value.phase ?? value.stage });
  progress({ phase: 'assets', message: 'Reading the verified runtime catalog…' });
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Cannot load the runtime catalog: HTTP ${response.status}.`);
  const manifest = await response.json();
  const config = normalizeConfiguration(input, { catalog: parseCatalog(manifest), baseURL: base.href });
  const phpEntry = manifest.php.find(entry => entry.version === config.phpVersion);
  const joomlaEntry = manifest.joomla.find(entry => entry.version === config.joomlaVersion);
  const resolveAsset = value => new URL(value, manifestUrl).href;
  const identity = await storageIdentity(config.storageKey);
  const clientId = await clientIdentity();
  const release = config.persistence ? await acquireSiteLock(identity) : async () => {};
  const instanceId = crypto.randomUUID();
  let database, session, closePromise, changing = false, lastCheckpoint;
  const prefix = `${base.pathname}__site/${clientId}/${instanceId}/`;
  const siteUrl = new URL(prefix, base).href;
  const registerSession = () => instances.set(instanceId, {
    send: (operation, args) => session.send(operation, args, phpRequestTimeoutMs(config.phpSettings)),
  });
  const finish = erase => closePromise ??= (async () => {
    instances.delete(instanceId);
    try {
      try { await session?.close(); } finally { await database?.close(); }
      if (erase && config.persistence) await eraseStoredSite(identity);
    } finally { await release(); }
  })();
  try {
    progress({ phase: 'database', message: 'Starting MariaDB…' });
    const { createMariaDB } = await import(resolveAsset(manifest.bridge.moduleUrl));
    database = await createMariaDB({ database: 'joomla', timeoutMs: 120_000, ...(config.persistence ? { persistence: { key: `joomengine-${identity}` } } : {}) });
    session = new PhpSession(database, error => progress({ phase: 'failed', message: error.message }));
    progress({ phase: 'php', message: `Loading PHP ${phpEntry.patchVersion ?? config.phpVersion} and its extensions…` });
    const initializeSession = (target, settings = config.phpSettings) => target.send('initialize', {
      moduleUrl: resolveAsset(phpEntry.moduleUrl), adapterUrl: resolveAsset(manifest.bridge.adapterUrl),
      phpVersion: config.phpVersion, prefix, persistence: config.persistence, mountPath: `/joomengine-${identity}`,
      phpSettings: settings,
      sharedLibs: phpEntry.sharedLibs.map(lib => ({ ...lib, url: resolveAsset(lib.url) })),
      files: (phpEntry.files ?? []).map(file => ({ ...file, url: resolveAsset(file.url) })),
    });
    const runtimeInfo = await initializeSession(session);
    const handle = {
      url: new URL(config.initialPath.slice(1), siteUrl).href, baseUrl: siteUrl,
      documentRoot: '/persist/www', installMarkerPath: '/persist/meta/joomla-install.json', runtimeInfo,
      get configuration() { return structuredClone(config); },
      get closed() { return Boolean(closePromise); },
      get changing() { return changing; },
      lastSavedAt: null,
      fs: Object.fromEntries(['mkdir', 'readFile', 'writeFile', 'readdir', 'stat', 'unlink'].map(method => [method,
        (path, data) => session.send(`fs.${method}`, { path, data })])),
      runPhp: (source, options = {}) => session.send('runPhp', { source }, options.timeoutMs ?? 180_000),
      async request(path = '/', init = {}) {
        const target = normalizeInitialPath(`/${String(path).replace(/^\/+/, '')}`);
        const request = new Request(new URL(target.slice(1), siteUrl), init);
        return restoreResponse(await session.send('request', await serializeRequest(request), init.timeoutMs ?? phpRequestTimeoutMs(config.phpSettings)), request.method);
      },
      async flush() {
        if (changing) throw new Error('Wait for the current site operation before saving.');
        await session.flushTogether();
        handle.lastSavedAt = config.persistence ? new Date().toISOString() : null;
      },
      exportSite: options => exportSite(handle, options),
      discoverConfiguration: () => discoverJoomlaConfiguration(handle),
      openStandalone: options => openStandalone(handle, options),
      reset: () => finish(true), close: () => finish(false),
      async checkpoint() {
        if (closePromise) throw new Error('Open the site before creating a checkpoint.');
        const archive = await exportSite(handle, { format: 'bundle' });
        const filesystem = await session.send('checkpoint', {}, 600_000);
        return { archive: archive.bytes, sha256: await sha256(archive.bytes), filesystem, configuration: { ...structuredClone(config), admin: { ...handle.installation.administrator } } };
      },
      async keep() {
        if (config.persistence) { await handle.flush(); return handle; }
        if (changing) throw new Error('Wait for the current site operation.');
        changing = true; instances.delete(instanceId);
        try {
          progress({ phase: 'saving', message: 'Saving the temporary site and verifying its files and database…' });
          const saved = await handle.checkpoint();
          const replacement = await createPlayground({ ...saved.configuration, persistence: true, storageKey: `saved-${crypto.randomUUID()}`, fresh: false }, { onProgress, checkpoint: saved });
          await finish(false);
          return replacement;
        } catch (error) { registerSession(); throw error; }
        finally { changing = false; }
      },
      async applyConfiguration(inputConfiguration) {
        if (changing || closePromise) throw new Error('Wait for the current site operation.');
        const next = normalizeConfiguration({ ...config, ...inputConfiguration, admin: handle.installation.administrator }, { catalog: parseCatalog(manifest), baseURL: base.href });
        if (next.phpVersion !== config.phpVersion || next.joomlaVersion !== config.joomlaVersion || next.persistence !== config.persistence || next.storageKey !== config.storageKey) {
          throw new Error('Use a new deployment or the PHP settings control to change the runtime or storage.');
        }
        changing = true; instances.delete(instanceId);
        try {
          progress({ phase: 'saving', message: 'Creating a recovery checkpoint before applying deployment changes…' });
          lastCheckpoint = await handle.checkpoint();
          const result = await applyJoomlaConfiguration(handle, next, { progress });
          Object.assign(config, next);
          handle.installation = { ...handle.installation, ...result, administrator: handle.installation.administrator };
          await session.send('flush'); await database.flush();
          registerSession();
          progress({ phase: 'ready', message: 'Deployment changes applied to the current site.' });
          return result;
        } catch (error) {
          registerSession();
          if (lastCheckpoint) error.recover = () => createPlayground({ ...lastCheckpoint.configuration, storageKey: `recovery-${crypto.randomUUID()}`, fresh: false }, { onProgress, checkpoint: lastCheckpoint });
          throw error;
        } finally { changing = false; }
      },
      async updatePhpSettings(inputSettings) {
        if (changing || closePromise) throw new Error('Wait for the current site operation before restarting PHP.');
        const settings = normalizePhpSettings(inputSettings);
        const previous = config.phpSettings;
        changing = true; instances.delete(instanceId);
        let filesystem;
        try {
          progress({ phase: 'php', message: 'Checkpointing site files before restarting PHP…' });
          filesystem = await session.send('checkpoint', {}, 600_000);
          await database.flush();
          await session.close();
          session = new PhpSession(database, error => progress({ phase: 'failed', message: error.message }));
          handle.runtimeInfo = await initializeSession(session, settings);
          await session.send('restoreCheckpoint', { bytes: filesystem }, 600_000);
          config.phpSettings = settings;
          await session.send('flush'); await database.flush();
          registerSession();
          progress({ phase: 'ready', message: 'PHP settings applied. Your site files and database are unchanged.' });
          return handle.runtimeInfo;
        } catch (error) {
          if (filesystem) {
            try {
              await session.close().catch(() => {});
              session = new PhpSession(database, problem => progress({ phase: 'failed', message: problem.message }));
              handle.runtimeInfo = await initializeSession(session, previous);
              await session.send('restoreCheckpoint', { bytes: filesystem }, 600_000);
              config.phpSettings = previous;
              registerSession();
              error.message += ' The previous PHP settings and site files were restored.';
            } catch (recoveryError) { error.message += ` Recovery failed: ${recoveryError.message}`; }
          } else registerSession();
          throw error;
        } finally { changing = false; }
      },
    };
    const state = await inspectJoomla(handle);
    const pristine = !state.marker && !state.configured && !state.installerPresent;
    let installed;
    if (checkpoint) {
      if (!pristine) throw new Error('Restore a private checkpoint into a new site.');
      installed = await importJoomlaSnapshot(handle, { ...config, addonExtensions: [], addonStartupCommands: [] }, {
        archiveBytes: checkpoint.archive, sha256: checkpoint.sha256, progress,
      });
      await session.send('restoreCheckpoint', { bytes: checkpoint.filesystem }, 600_000);
      installed.administrator = await restoreJoomlaSession(handle, config);
      installed.resumed = true;
    } else if (pristine && config.snapshot && !config.fresh) {
      progress({ phase: 'download', message: 'Loading the prepared deploy…' });
      const archive = await fetch(config.snapshot.url);
      if (!archive.ok) throw new Error(`Cannot load the prepared deploy: HTTP ${archive.status}.`);
      installed = await importJoomlaSnapshot(handle, config, {
        archiveBytes: await archive.arrayBuffer(), sha256: config.snapshot.sha256, progress,
      });
    } else {
      let archiveBytes;
      if (pristine) {
        progress({ phase: 'download', message: `Loading Joomla ${config.joomlaVersion}…` });
        const archive = await fetch(resolveAsset(joomlaEntry.url));
        if (!archive.ok) throw new Error(`Cannot load Joomla: HTTP ${archive.status}.`);
        archiveBytes = await archive.arrayBuffer();
      }
      installed = await installJoomla(handle, config, { archiveBytes, sha256: joomlaEntry.sha256, progress });
    }
    await handle.flush();
    handle.installation = installed;
    registerSession();
    progress({ phase: 'ready', message: installed.resumed ? 'Your saved Joomla site is ready.' : 'Joomla is installed and ready.' });
    return handle;
  } catch (error) {
    try { await finish(false); } catch (cleanupError) { error.message += ` Cleanup: ${cleanupError.message}`; }
    throw error;
  }
}
