import { catalogWithSelectedJoomlaPackage, normalizeConfiguration, parseCatalog, normalizeInitialPath, resolveSiteURL } from './config.mjs';
import { installJoomla, inspectJoomla, sha256, importJoomlaSnapshot, importJoomlaCheckpoint, checkJoomla, restoreJoomlaSession, applyJoomlaConfiguration, discoverJoomlaConfiguration, getMcpConnection, readJoomlaAdministrator, repairJoomlaConfiguration, runStartupCommand } from './joomla/index.mjs';
import { exportSite } from './export.mjs';
import { serializeRequest, restoreResponse } from './http.mjs';
import { normalizePhpSettings, phpRequestTimeoutMs } from './php-settings.mjs';
import { openSiteDatabase } from './saved-site-recovery.mjs';
import { createPackageFetcher } from './dynamic-packages.mjs';
import { prepareBrowserIsolation } from './isolation-bootstrap.mjs';
import { ownedClientURL } from './isolation.mjs';
import { loadPublicAssetConfiguration } from './public-assets.mjs';
import { deploymentImages, deploymentImageFingerprint, deploymentSnapshotSource, completedDeploymentImageConfiguration } from './deployment-images.mjs';
import { catalogForRestoredSite } from './site-import.mjs';
import { deploymentConfigurationChanges } from './deployment-changes.mjs';
import { importJoomlaSiteExport } from './joomla/index.mjs';

const base = new URL('../', import.meta.url);
const manifestUrl = new URL('assets/manifest.json', base);
const instances = new Map();
let preparation;
let listenerInstalled = false;

/** Install the routing/isolation worker before collecting user input. */
export function prepareEnvironment() {
  if (preparation) return preparation;
  preparation = (async () => {
    const environment = await prepareBrowserIsolation({ baseURL: base.href });
    if (!listenerInstalled) {
      navigator.serviceWorker.addEventListener('message', receiveSiteRequest);
      listenerInstalled = true;
    }
    return environment;
  })().catch(error => { preparation = undefined; throw error; });
  return preparation;
}
async function receiveSiteRequest(event) {
  if (event.source?.scriptURL !== new URL('service-worker.mjs', base).href || event.data?.type !== 'playground-request' || !event.ports[0]) return;
  const port = event.ports[0];
  try {
    const instance = instances.get(event.data.instanceId);
    if (!instance) throw new Error('This playground session is no longer open.');
    port.postMessage(await instance.send('request', event.data.request, state => {
      port.postMessage({ type: 'playground-request-state', state });
    }));
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

export class PhpSession {
  constructor(database, onFailure, onDiagnostic, isolation) {
    this.database = database;
    this.onFailure = onFailure;
    this.onDiagnostic = onDiagnostic;
    this.worker = new Worker(isolation ? ownedClientURL(new URL('./php-worker.mjs', import.meta.url), { baseURL: base.href, ...isolation }) : new URL('./php-worker.mjs', import.meta.url), { type: 'module' });
    this.sequence = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.queued = 0;
    this.failure = null;
    this.workspaceListeners = new Set();
    this.workspaceReads = new Set();
    this.debugListeners = new Set();
    this.requestProgress = new Set();
    this.debugState = 'idle';
    this.debugPauseGeneration = 0;
    this.worker.addEventListener('error', event => this.fail(new Error(event.message || 'The PHP worker failed.')));
    this.worker.addEventListener('messageerror', () => this.fail(new Error('The PHP worker sent an unreadable message.')));
    this.worker.addEventListener('message', event => this.receive(event.data));
  }
  async receive(message) {
    if (message?.type === 'debug-state' || message?.type === 'debug-event') {
      if (message.type === 'debug-state') {
        this.debugState = message.state;
        const pending = this.pending.get(message.requestId);
        if (pending?.operation === 'request') {
          if (message.state === 'paused') clearTimeout(pending.timer);
          else if (message.state === 'running' || message.state === 'idle') pending.armTimer();
        }
        // A paused request also holds later HTTP requests in the owner queue.
        // Suspend their service-worker deadlines before they start executing.
        for (const listener of this.requestProgress) {
          try { listener(message.state); } catch { /* A closed response port cannot interrupt PHP. */ }
        }
        if (message.state === 'paused') {
          this.debugPauseGeneration++;
          for (const read of this.workspaceReads) this.dispatchPausedWorkspaceRead(read);
        }
      }
      for (const listener of this.debugListeners) { try { listener(message); } catch { /* Debug views do not own PHP. */ } }
      return;
    }
    if (message?.type === 'workspace-change' || message?.type === 'workspace-invalidated') {
      for (const listener of this.workspaceListeners) {
        try { listener(message); } catch { /* A view cannot fail the site owner. */ }
      }
      return;
    }
    if (message?.type === 'database-call') {
      try {
        if (!this.database) throw new Error('The database is unavailable in files-only recovery.');
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
        if (message.value?.diagnostic) {
          try { this.onDiagnostic?.(message.value.diagnostic); } catch { /* Logging must not fail a completed PHP request. */ }
        }
        // Joomla can retain PDO in its container until late PHP shutdown.
        // The completed CGI request is the definitive connection boundary.
        if (['request', 'runPhp'].includes(pending.operation) && message.value?.databaseUsed !== false) await this.database?.reset();
        if (message.error) pending.reject(Object.assign(new Error(message.error), { code: message.code }));
        else pending.resolve(message.value);
      } catch (error) { await this.fail(error); pending.reject(error); }
    }
  }
  send(operation, args = {}, timeoutMs = 180_000, onProgress) {
    if (this.failure) return Promise.reject(this.failure);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 600_000) return Promise.reject(new RangeError('Timeout must be between 10 and 600000 milliseconds.'));
    if (this.queued >= 64) return Promise.reject(new Error('The PHP request queue is full.'));
    const progress = operation === 'request' && typeof onProgress === 'function' ? state => onProgress(state) : null;
    if (progress) {
      this.requestProgress.add(progress);
      if (this.debugState === 'paused') {
        try { progress('paused'); } catch { /* The caller may have abandoned this response. */ }
      }
    }
    this.queued++;
    const result = this.queue.then(() => {
      if (this.failure) throw this.failure;
      return this.perform(operation, args, timeoutMs);
    }).finally(() => { this.queued--; if (progress) this.requestProgress.delete(progress); });
    this.queue = result.catch(() => {});
    return result;
  }
  perform(operation, args = {}, timeoutMs = 180_000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = () => {
        const error = new Error(`PHP ${operation} timed out after ${timeoutMs} ms. Restart the playground; the operation was not replayed.`);
        error.code = 'TIMEOUT';
        this.fail(error);
      };
      const pending = { resolve, reject, operation,
        armTimer() { clearTimeout(this.timer); this.timer = setTimeout(timeout, timeoutMs); } };
      pending.armTimer();
      this.pending.set(id, pending);
      try { this.worker.postMessage({ type: 'operation', id, operation, args }); }
      catch (error) { this.fail(error); }
    });
  }
  debugCommand(command, args = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`PHP debugger ${command} did not respond.`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer, operation: 'debug-command' });
      this.worker.postMessage({ type: 'debug-command', id, command, args });
    });
  }
  workspaceRequest(operation, args = {}) {
    if (!['read', 'stat', 'list', 'search', 'cancelSearch'].includes(operation)) return this.send(`workspace.${operation}`, args);
    if (this.failure) return Promise.reject(this.failure);
    // Paused source inspection must remain available even when HTTP/writes fill
    // the ordinary FIFO. Both lanes remain bounded independently.
    if (this.workspaceReads.size >= 64 || (this.debugState !== 'paused' && this.queued >= 64)) return Promise.reject(new Error('The PHP request queue is full.'));
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const read = { operation, args, state: 'queued', queued: false,
      finish: (error, value) => {
        if (read.state === 'finished') return;
        read.state = 'finished'; this.workspaceReads.delete(read); this.queued--;
        if (error) reject(error); else resolve(value);
      },
    };
    this.queued++; this.workspaceReads.add(read);
    if (this.debugState === 'paused') this.dispatchPausedWorkspaceRead(read);
    else this.queueWorkspaceRead(read);
    return result;
  }
  queueWorkspaceRead(read) {
    if (read.queued || read.state === 'finished') return;
    read.queued = true;
    const queued = this.queue.then(async () => {
      // A pause may have moved this read to the debugger's live filesystem.
      // Keep its original FIFO position as a no-op so writes never move ahead.
      while (read.state === 'direct') await read.direct;
      if (read.state !== 'queued' && read.state !== 'retry') return;
      read.state = 'normal';
      try { read.finish(null, await this.perform(`workspace.${read.operation}`, read.args)); }
      catch (error) { read.finish(error); }
    });
    this.queue = queued.catch(error => { read.finish(error); });
  }
  dispatchPausedWorkspaceRead(read) {
    if (read.state !== 'queued' && read.state !== 'retry') return;
    read.state = 'direct';
    const pauseGeneration = this.debugPauseGeneration;
    read.direct = this.debugCommand('workspaceRead', { operation: read.operation, args: read.args }).then(
      value => { read.finish(null, value); },
      error => {
        if (read.state === 'finished') return;
        if (error.code === 'DEBUG_NOT_PAUSED' && !this.failure) {
          // Continue/stop won the race. Read only after the normal owner queue
          // regains the returned filesystem; never fall back to a stale copy.
          read.state = 'retry';
          // A step may already have reached a newer pause before the old read's
          // rejection arrives. Retry that new snapshot once per pause, rather
          // than leaving source navigation behind the still-running request.
          if (this.debugState === 'paused' && this.debugPauseGeneration !== pauseGeneration) this.dispatchPausedWorkspaceRead(read);
          else this.queueWorkspaceRead(read);
        } else read.finish(error);
      },
    );
  }
  withWorkspaceBatch(callback) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queued >= 64) return Promise.reject(new Error('The PHP request queue is full.'));
    this.queued++;
    const result = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      let active = true, writes = Promise.resolve();
      const request = (operation, args) => {
        if (!active) return Promise.reject(new Error('This workspace write batch has finished.'));
        if (!/^[a-zA-Z]+$/.test(operation)) return Promise.reject(new TypeError('Invalid workspace operation.'));
        const pending = writes.then(() => this.perform(`workspace.${operation}`, args));
        writes = pending.catch(() => {});
        return pending;
      };
      try { return await callback(request); }
      finally { active = false; await writes; }
    }).finally(() => { this.queued--; });
    // HTTP and persistence work enqueued after Save All cannot split its files.
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
      await this.database?.flush();
    } finally { release(); }
  }
  fail(error) {
    if (this.failure) return this.recovery;
    this.failure = error;
    this.worker.terminate();
    try { this.onFailure?.(error); } catch { /* Cleanup still completes if a UI callback fails. */ }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const read of this.workspaceReads) read.finish(error);
    this.recovery = this.database?.reset().catch(() => {});
    return this.recovery;
  }
  async close() {
    try { if (!this.failure) { await this.debugCommand('stop').catch(() => {}); await this.send('close'); } }
    finally {
      this.workspaceListeners.clear(); this.debugListeners.clear(); this.requestProgress.clear();
      this.worker.terminate(); this.failure ??= new Error('This PHP session is closed.');
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
      this.pending.clear();
      for (const read of this.workspaceReads) read.finish(this.failure);
      await this.recovery;
    }
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
  const { clearEditorDrafts } = await import('./code/editor-session.mjs');
  await clearEditorDrafts(identity);
}
/** Erase a closed or incompletely installed saved site after user confirmation. */
export async function resetPlayground({ storageKey = 'default' } = {}) {
  const identity = await storageIdentity(storageKey);
  const release = await acquireSiteLock(identity);
  try { await eraseStoredSite(identity); } finally { await release(); }
}

/** Create a real Joomla installation backed by upstream PHP and MariaDB WASM. */
export async function createPlayground(input, { onProgress = () => {}, checkpoint = null, siteExport = null, recovery = false, rotateAdministrator = false } = {}) {
  const environment = await prepareEnvironment();
  if (environment.reloadRequired) throw new Error(environment.reason + ' Complete the controlled page navigation before starting the playground.');
  let imagePhase;
  const progress = value => {
    const phase = value.phase ?? value.stage;
    onProgress({ ...value, phase: imagePhase && !['warning', 'failed'].includes(phase) ? imagePhase : phase });
  };
  progress({ phase: 'assets', message: 'Reading the verified runtime catalog…' });
  const response = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Cannot load the runtime catalog: HTTP ${response.status}.`);
  const manifest = await response.json();
  const publishedCatalog = parseCatalog(manifest, { baseURL: manifestUrl });
  const selectedCatalog = input.restoredSite ? catalogForRestoredSite(publishedCatalog, input)
    : catalogWithSelectedJoomlaPackage(publishedCatalog, input, base.href);
  if (input.joomlaPackage !== undefined) {
    const selected = selectedCatalog.joomla.find(entry => entry.version === input.joomlaVersion);
    manifest.joomla = manifest.joomla.filter(entry => entry.version !== input.joomlaVersion);
    manifest.joomla.push(selected);
  }
  const config = normalizeConfiguration(input, { catalog: selectedCatalog, baseURL: base.href });
  const fetchPackage = createPackageFetcher([config.joomlaPackage, config.jcbPackage].filter(Boolean), fetch);
  let phpEntry = manifest.php.find(entry => entry.version === config.phpVersion);
  const joomlaEntry = selectedCatalog.joomla.find(entry => entry.version === config.joomlaVersion);
  const isolation = Object.freeze({ policy: environment.policy, mode: environment.mode, ownerId: environment.ownerId, bootstrapVersion: environment.bootstrapVersion });
  let publicAssets;
  if (environment.mode === 'compatibility') {
    try { publicAssets = await loadPublicAssetConfiguration(base.href); }
    catch {
      progress({ phase: 'warning', message: 'Image delivery settings are unavailable. Original image URLs will be used.' });
    }
  }
  const resolveAsset = value => ownedClientURL(new URL(value, manifestUrl), { baseURL: base.href, ...isolation });
  const identity = await storageIdentity(config.storageKey);
  const clientId = await clientIdentity();
  const release = config.persistence ? await acquireSiteLock(identity) : async () => {};
  const instanceId = crypto.randomUUID();
  let database, session, closePromise, changing = false, databaseError = null, adminerOpened = false;
  const workspaceListeners = new Set();
  const debugListeners = new Set();
  let debugState = 'idle';
  const workspaceEvent = event => {
    for (const listener of workspaceListeners) {
      try { listener(event); } catch { /* Listener errors must not stop the runtime. */ }
    }
  };
  const pausedOperation = Symbol('paused site operation');
  const prefix = `${base.pathname}__site/${clientId}/${instanceId}/`;
  const siteUrl = new URL(prefix, base).href;
  const registerSession = () => instances.set(instanceId, {
    send: (operation, args, onProgress) => session.send(operation, args, phpRequestTimeoutMs(config.phpSettings), onProgress),
  });
  const finish = erase => closePromise ??= (async () => {
    instances.delete(instanceId);
    workspaceEvent({ type: 'workspace-closed', erased: Boolean(erase) });
    workspaceListeners.clear();
    debugListeners.clear();
    try {
      try { await session?.close(); } finally { await database?.close(); }
      if (erase && config.persistence) await eraseStoredSite(identity);
    } finally { await release(); }
  })();
  const restorePrivateCopy = async (saved, kind, persistence = saved.configuration.persistence) => {
    const storageKey = `${kind}-${crypto.randomUUID()}`;
    try {
      return await createPlayground({ ...saved.configuration, persistence, storageKey, fresh: false }, { onProgress, checkpoint: saved });
    } catch (error) {
      // This key was allocated for this attempt; a failed copy must not fill
      // browser storage with an unreachable partial installation.
      if (persistence) {
        try { await resetPlayground({ storageKey }); }
        catch (cleanupError) { error.message += ` Partial copy cleanup: ${cleanupError.message}`; }
      }
      throw error;
    }
  };
  try {
    progress({ phase: 'database', message: 'Starting MariaDB…' });
    ({ database, error: databaseError } = await openSiteDatabase(async () => {
      const { createMariaDB } = await import(resolveAsset(manifest.bridge.moduleUrl));
      return createMariaDB({ database: 'joomla', timeoutMs: 120_000, ...(config.persistence ? { persistence: { key: `joomengine-${identity}` } } : {}) });
    }, { recovery, persistent: config.persistence }));
    const filesOnly = databaseError !== null;
    if (filesOnly) progress({ phase: 'warning', message: `${databaseError.message} Opening saved files without changing browser storage.` });
    const requireDatabase = () => {
      if (filesOnly) throw new Error('Only file recovery is available. The database could not start; download the recovery files or close and retry.');
    };
    const createSession = () => {
      const created = new PhpSession(database,
        error => { workspaceEvent({ type: 'workspace-failed', message: error.message }); progress({ phase: 'failed', message: error.message }); },
        message => progress({ phase: 'warning', message }), isolation);
      created.workspaceListeners.add(workspaceEvent);
      created.debugListeners.add(message => {
        if (message.type === 'debug-state') { debugState = message.state; workspaceEvent(message); }
        else for (const listener of debugListeners) { try { listener({ event: message.event, body: message.body }); } catch { /* Isolate view errors. */ } }
      });
      return created;
    };
    session = createSession();
    progress({ phase: 'php', message: `Loading PHP ${phpEntry.patchVersion ?? config.phpVersion} and its extensions…` });
    const initializeSession = (target, settings = config.phpSettings) => target.send('initialize', {
      moduleUrl: resolveAsset(phpEntry.moduleUrl), adapterUrl: resolveAsset(manifest.bridge.adapterUrl),
      phpVersion: config.phpVersion, prefix, persistence: config.persistence, mountPath: `/joomengine-${identity}`, readOnly: filesOnly,
      phpSettings: settings, isolationPolicy: isolation.policy, publicAssets,
      sharedLibs: phpEntry.sharedLibs.map(lib => ({ ...lib, url: resolveAsset(lib.url) })),
      files: (phpEntry.files ?? []).map(file => ({ ...file, url: resolveAsset(file.url) })),
      debugger: phpEntry.debugger ? { moduleUrl: resolveAsset(phpEntry.debugger.moduleUrl),
        sharedLibs: phpEntry.debugger.sharedLibs.map(lib => ({ ...lib, url: resolveAsset(lib.url) })) } : undefined,
    });
    const runtimeInfo = await initializeSession(session);
    const handle = {
      url: resolveSiteURL(config.initialPath, siteUrl), baseUrl: siteUrl, isolation,
      documentRoot: '/persist/www', installMarkerPath: '/persist/meta/joomla-install.json', runtimeInfo,
      get configuration() { return structuredClone(config); },
      get closed() { return Boolean(closePromise); },
      get healthy() { return !closePromise && !session.failure; },
      get changing() { return changing; },
      recovery: null,
      lastSavedAt: null,
      debugger: {
        capabilities: { conditionalBreakpoints: true },
        get state() { return debugState; },
        async start(configuration = {}) {
          requireDatabase();
          if (changing || closePromise) throw new Error('Wait for the current site operation before debugging.');
          if (!phpEntry.debugger) throw new Error('Rebuild Playground with the PHP debugger assets before starting a debug session.');
          return session.send('debug.arm', { method: configuration.method || 'GET',
            url: configuration.url || handle.url, headers: configuration.headers || [], destination: configuration.destination });
        },
        subscribe(listener) { debugListeners.add(listener); return () => debugListeners.delete(listener); },
        setBreakpoints: (path, breakpoints) => session.debugCommand('setBreakpoints', { path, breakpoints }),
        continue: () => session.debugCommand('continue'),
        next: () => session.debugCommand('next'),
        stepIn: () => session.debugCommand('stepIn'),
        stepOut: () => session.debugCommand('stepOut'),
        pause: () => session.debugCommand('pause'),
        stop: () => session.debugCommand('stop'),
        stackTrace: () => session.debugCommand('stackTrace'),
        scopes: frameId => session.debugCommand('scopes', { frameId }),
        variables: (reference, options) => session.debugCommand('variables', { reference, ...options }),
        evaluate: (expression, frameId) => session.debugCommand('evaluate', { expression, frameId }),
      },
      workspace: {
        id: instanceId,
        storageId: config.persistence ? identity : null,
        root: '/',
        async request(operation, args = {}) {
          if (closePromise) throw new Error('This JoomEngine Code workspace is closed.');
          if (changing) throw new Error('Wait for the current site operation before using JoomEngine Code.');
          if (!/^[a-zA-Z]+$/.test(operation)) throw new TypeError('Invalid workspace operation.');
          return session.workspaceRequest(operation, args);
        },
        subscribe(listener) {
          if (typeof listener !== 'function') throw new TypeError('A workspace listener is required.');
          workspaceListeners.add(listener);
          return () => workspaceListeners.delete(listener);
        },
        withBatch(callback) {
          if (closePromise || changing) return Promise.reject(new Error('Wait for the current site operation before saving files.'));
          if (typeof callback !== 'function') return Promise.reject(new TypeError('A workspace batch callback is required.'));
          return session.withWorkspaceBatch(request => callback({ ...handle.workspace, request, withBatch: undefined }));
        },
      },
      fs: Object.fromEntries(['mkdir', 'readFile', 'writeFile', 'readdir', 'stat', 'unlink'].map(method => [method,
        (path, data) => session.send(`fs.${method}`, { path, data })])),
      runPhp: (source, options = {}) => session.send('runPhp', { source }, options.timeoutMs ?? 180_000),
      async openDatabase() {
        requireDatabase();
        if (changing || closePromise) throw new Error('Wait for the current site operation before opening Database.');
        if (debugState === 'paused') throw new Error('Continue or stop the paused PHP request before opening Database.');
        await session.send('database.install');
        adminerOpened = true;
        return { url: new URL('__adminer/', siteUrl).href };
      },
      async clearJoomlaCache() {
        requireDatabase();
        if (changing || closePromise) throw new Error('Wait for the current site operation before clearing Joomla caches.');
        if (debugState === 'paused') throw new Error('Continue or stop the paused PHP request before clearing Joomla caches.');
        const result = await runStartupCommand(handle, ['cache:clean']);
        await session.flushTogether();
        return result;
      },
      async request(path = '/', init = {}) {
        requireDatabase();
        const target = normalizeInitialPath(`/${String(path).replace(/^\/+/, '')}`);
        const request = new Request(resolveSiteURL(target, siteUrl), init);
        return restoreResponse(await session.send('request', await serializeRequest(request), init.timeoutMs ?? phpRequestTimeoutMs(config.phpSettings)), request.method);
      },
      async flush() {
        requireDatabase();
        if (changing) throw new Error('Wait for the current site operation before saving.');
        await session.flushTogether();
        handle.lastSavedAt = config.persistence ? new Date().toISOString() : null;
      },
      exportSite: options => { requireDatabase(); return exportSite(handle, options); },
      async exportRecoveryFiles() {
        if (changing || closePromise) throw new Error('Wait for the current site operation before exporting recovery files.');
        changing = true; instances.delete(instanceId);
        try {
          const bytes = await session.send('checkpoint', {}, 600_000);
          return { bytes, filename: `joomengine-recovery-${config.storageKey}.zip`, mimeType: 'application/zip' };
        } finally { changing = false; if (!filesOnly) registerSession(); }
      },
      discoverConfiguration: () => discoverJoomlaConfiguration(handle),
      getMcpConnection: () => getMcpConnection(handle, { admin: handle.installation?.administrator }),
      async repairConfiguration() {
        requireDatabase();
        if (changing || closePromise) throw new Error('Wait for the current site operation before repairing configuration.');
        changing = true; instances.delete(instanceId);
        try {
          const result = await repairJoomlaConfiguration(handle);
          await session.flushTogether();
          progress({ phase: 'recovery', message: 'Debugging and error reporting were reset. The original configuration is backed up; restart to open Joomla.' });
          return result;
        } finally { changing = false; registerSession(); }
      },
      reset: () => finish(true), close: () => finish(false),
      async checkpoint(token) {
        requireDatabase();
        if (closePromise) throw new Error('Open the site before creating a checkpoint.');
        const managePause = token !== pausedOperation;
        if (managePause && changing) throw new Error('Wait for the current site operation.');
        if (managePause) { changing = true; instances.delete(instanceId); }
        try {
          const archive = await exportSite(handle, { format: 'bundle' });
          const filesystem = await session.send('checkpoint', {}, 600_000);
          return { archive: archive.bytes, sha256: await sha256(archive.bytes), filesystem, configuration: { ...structuredClone(config), admin: { ...handle.installation.administrator } } };
        } finally { if (managePause) { changing = false; registerSession(); } }
      },
      async keep() {
        requireDatabase();
        if (config.persistence) { await handle.flush(); return handle; }
        if (changing) throw new Error('Wait for the current site operation.');
        changing = true; instances.delete(instanceId);
        try {
          progress({ phase: 'saving', message: 'Saving the temporary site and verifying its files and database…' });
          const saved = await handle.checkpoint(pausedOperation);
          const replacement = await restorePrivateCopy(saved, 'saved', true);
          try { await finish(false); }
          catch (cleanupError) { progress({ phase: 'warning', message: `The saved site is ready. Previous runtime cleanup reported: ${cleanupError.message}` }); }
          return replacement;
        } catch (error) { registerSession(); throw error; }
        finally { changing = false; }
      },
      async applyConfiguration(inputConfiguration) {
        requireDatabase();
        if (changing || closePromise) throw new Error('Wait for the current site operation.');
        const next = normalizeConfiguration({ ...config, ...inputConfiguration, admin: handle.installation.administrator }, { catalog: selectedCatalog, baseURL: base.href });
        if (next.phpVersion !== config.phpVersion || next.joomlaVersion !== config.joomlaVersion || next.persistence !== config.persistence || next.storageKey !== config.storageKey) {
          throw new Error('Use a new deployment or the PHP settings control to change the runtime or storage.');
        }
        if ((next.jcbVersion ?? 'none') !== (config.jcbVersion ?? 'none') || JSON.stringify(next.jcbPackage ?? null) !== JSON.stringify(config.jcbPackage ?? null)) {
          throw new Error('Use a new deployment to change the selected JCB version.');
        }
        if (JSON.stringify(next.phpSettings) !== JSON.stringify(config.phpSettings)) throw new Error('Apply PHP settings using the PHP settings dialog before changing site configuration.');
        changing = true; instances.delete(instanceId);
        let recoveryCheckpoint;
        try {
          progress({ phase: 'saving', message: 'Creating a recovery checkpoint before applying deployment changes…' });
          recoveryCheckpoint = await handle.checkpoint(pausedOperation);
          const changes = deploymentConfigurationChanges(config, next);
          const result = await applyJoomlaConfiguration(handle, changes.configuration, { progress, fetchPackage,
            configureLanguage: changes.configureLanguage });
          Object.assign(config, next);
          handle.url = resolveSiteURL(config.initialPath, siteUrl);
          handle.installation = { ...handle.installation, ...result, administrator: handle.installation.administrator };
          await session.flushTogether();
          registerSession();
          progress({ phase: 'ready', message: 'Deployment changes applied to the current site.' });
          return result;
        } catch (error) {
          registerSession();
          if (recoveryCheckpoint) error.recover = () => restorePrivateCopy(recoveryCheckpoint, 'recovery');
          throw error;
        } finally { changing = false; }
      },
      switchPhpVersion: version => handle.updatePhpSettings(config.phpSettings, version),
      async updatePhpSettings(inputSettings, version = config.phpVersion) {
        requireDatabase();
        if (changing || closePromise) throw new Error('Wait for the current site operation before restarting PHP.');
        const settings = normalizePhpSettings(inputSettings);
        const previous = config.phpSettings;
        const previousEntry = phpEntry;
        const previousVersion = config.phpVersion;
        const selected = manifest.php.find(entry => entry.version === version);
        if (!selected || !joomlaEntry.php.includes(version)) throw new Error('This PHP build is not supported by the selected Joomla release.');
        changing = true; instances.delete(instanceId);
        let filesystem;
        try {
          progress({ phase: 'php', message: 'Checkpointing site files before restarting PHP…' });
          filesystem = await session.send('checkpoint', {}, 600_000);
          await session.flushTogether();
          await session.close();
          phpEntry = selected; config.phpVersion = version;
          session = createSession();
          handle.runtimeInfo = await initializeSession(session, settings);
          await session.send('restoreCheckpoint', { bytes: filesystem }, 600_000);
          // Tool sources are intentionally excluded from portable checkpoints.
          // Restore an already-open embedded/detached view before exposing the
          // replacement worker; its next navigation or POST must stay usable.
          if (adminerOpened) await session.send('database.install');
          config.phpSettings = settings;
          await session.flushTogether();
          await session.send('enablePersistence');
          registerSession();
          workspaceEvent({ type: 'workspace-invalidated' });
          progress({ phase: 'ready', message: 'PHP settings applied. Your site files and database are unchanged.' });
          return handle.runtimeInfo;
        } catch (error) {
          if (filesystem) {
            try {
              await session.close().catch(() => {});
              phpEntry = previousEntry; config.phpVersion = previousVersion;
              session = createSession();
              handle.runtimeInfo = await initializeSession(session, previous);
              await session.send('restoreCheckpoint', { bytes: filesystem }, 600_000);
              if (adminerOpened) await session.send('database.install');
              config.phpSettings = previous;
              await session.send('enablePersistence');
              registerSession();
              error.message += ' The previous PHP settings and site files were restored.';
            } catch (recoveryError) { error.message += ` Recovery failed: ${recoveryError.message}`; }
          } else registerSession();
          throw error;
        } finally { changing = false; }
      },
    };
    const state = await inspectJoomla(handle, { recovery });
    const pristine = !state.marker && !state.configured && !state.installerPresent;
    if (recovery) {
      if (pristine && !state.markerError) throw new Error('There is no saved installation to recover. Start a new deployment.');
      let administrator = null;
      try { administrator = await readJoomlaAdministrator(handle); }
      catch (error) { progress({ phase: 'warning', message: `Saved login metadata could not be read. Site files remain available for recovery: ${error.message}` }); }
      handle.installation = { resumed: true, version: state.marker?.joomlaVersion ?? config.joomlaVersion,
        siteName: config.siteName, language: config.language, deployId: state.marker?.deployId, administrator };
      handle.recovery = { configured: state.configured, complete: state.marker?.state === 'complete', installerPresent: state.installerPresent, markerError: state.markerError,
        filesOnly, databaseAvailable: !filesOnly, databaseError: databaseError?.message ?? null };
      if (filesOnly) {
        handle.runPhp = async () => { requireDatabase(); };
        progress({ phase: 'recovery', message: 'Your saved files are available for download. The database could not start and is not included in this recovery archive. Saved browser storage has not been changed.' });
      } else {
        registerSession();
        progress({ phase: 'recovery', message: 'Recovery is ready. Export your saved site or repair its configuration before restarting Joomla.' });
      }
      return handle;
    }
    let installed;
    if (siteExport) {
      if (!pristine) throw new Error('Upload a site into a new playground instance.');
      imagePhase = 'launch-image';
      installed = await importJoomlaSiteExport(handle, config, { archiveBytes: siteExport.bytes, sha256: siteExport.sha256,
        preserveAdministrator: siteExport.preserveAdministrator, progress });
    } else if (checkpoint) {
      if (!pristine) throw new Error('Restore a private checkpoint into a new site.');
      installed = await importJoomlaCheckpoint(handle, config, {
        archiveBytes: checkpoint.archive, sha256: checkpoint.sha256, progress,
      });
      await session.send('restoreCheckpoint', { bytes: checkpoint.filesystem }, 600_000);
      if (rotateAdministrator) {
        installed = { ...installed, ...await checkJoomla(handle),
          administrator: await restoreJoomlaSession(handle, config, { rotateAdministrator: true }),
          administratorUnavailable: false, loginNotice: undefined };
      }
      else if (config.restoredSite) installed = { ...installed, ...await installJoomla(handle, config, { progress, fetchPackage }) };
      else {
        installed = { ...installed, ...await checkJoomla(handle) };
        installed.administrator = await restoreJoomlaSession(handle, config);
      }
      installed.resumed = true;
    } else {
      if (pristine && config.restoredSite) throw new Error('The saved uploaded site is unavailable. Upload its complete site export ZIP again.');
      const imageWarning = message => progress({ phase: 'warning', message });
      let image, fingerprint, completeImage = false, captureImage = false;
      if (pristine) {
        // Revalidate the small server catalog before using cached maintained
        // bytes. A changed image hash is authoritative, including for a base
        // that has local additions. Storage failure never prevents a launch.
        await deploymentImages.reconcile(manifest).catch(() => {});
        const snapshot = deploymentSnapshotSource(config, manifest, base.href);
        const maintained = snapshot?.maintained;
        captureImage = !maintained || Boolean(config.addonExtensions?.length || config.addonStartupCommands?.length
          || config.addonLanguages?.length || config.addonTemplate?.url || config.deploymentRecipe);
        if (captureImage) {
          fingerprint = await deploymentImageFingerprint(config, manifest, { baseURL: base.href });
          if (!config.fresh) {
            image = await deploymentImages.getCustom(fingerprint);
            completeImage = Boolean(image);
          }
        }
        if (!image && maintained && !config.fresh) {
          try { image = await deploymentImages.getMaintained(maintained, { onProgress: progress, onWarning: imageWarning }); }
          catch {
            imageWarning('The prepared image could not be loaded. Building the deployment from its packages…');
          }
        }
        if (!image && snapshot && !maintained) {
          imagePhase = 'download-image';
          progress({ message: 'Downloading the selected image…' });
          const response = await fetchPackage(snapshot.url);
          if (!response.ok) throw new Error(`The selected image could not be downloaded (HTTP ${response.status}).`);
          image = { bytes: new Uint8Array(await response.arrayBuffer()), sha256: snapshot.sha256 };
        }
      }
      let archiveBytes;
      if (image) {
        imagePhase = 'launch-image';
        progress({ message: 'Creating a separate site from the prepared image…' });
        try {
          installed = await importJoomlaSnapshot(handle, completeImage ? completedDeploymentImageConfiguration(config) : config, {
            archiveBytes: image.bytes, sha256: image.sha256, progress, fetchPackage,
          });
        } catch (error) {
          if (completeImage) await deploymentImages.remove(`custom:${fingerprint}`).catch(() => {});
          throw error;
        }
      } else if (pristine) {
        imagePhase = 'build-image';
        progress({ message: 'Building the deployment image…' });
        progress({ phase: 'download', message: `Loading Joomla ${config.joomlaVersion}…` });
        // Package URLs retain their catalog identity and ordinary CORS behavior;
        // only local runtime modules/workers use the ownership-preserving route.
        const archiveURL = new URL(joomlaEntry.url, manifestUrl).href;
        const archive = await fetchPackage(archiveURL);
        if (!archive.ok) throw new Error(`Cannot download Joomla ${config.joomlaVersion}: HTTP ${archive.status} at ${archiveURL}. Refresh the deployment catalog and try again.`);
        archiveBytes = await archive.arrayBuffer();
      }
      if (!installed) installed = await installJoomla(handle, config, { archiveBytes, sha256: joomlaEntry.sha256, progress, fetchPackage });
      if (pristine && captureImage && !completeImage && !installed.extensionWarnings?.length) {
        imagePhase = 'build-image';
        try {
          // This runs before registration/UI exposure, so the image contains
          // the completed recipe, never later edits made to an installed site.
          progress({ message: 'Preparing the image for reuse in this browser…' });
          const exported = await exportSite(handle, { format: 'bundle' });
          await deploymentImages.saveCustom(config, manifest, exported.bytes, {
            fingerprint, onProgress: progress, onWarning: imageWarning,
          });
        } catch { imageWarning('The image could not be saved locally. This site can still launch.'); }
      }
      imagePhase = 'launch-image';
      if (pristine) progress({ message: 'Launching your site…' });
    }
    imagePhase = undefined;
    await handle.flush();
    await session.send('enablePersistence');
    handle.installation = installed;
    registerSession();
    progress({ phase: 'ready', message: installed.resumed ? 'Your saved Joomla site is ready.' : 'Joomla is installed and ready.' });
    return handle;
  } catch (error) {
    try { await finish(false); } catch (cleanupError) { error.message += ` Cleanup: ${cleanupError.message}`; }
    throw error;
  }
}
