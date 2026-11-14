/**
 * Companion Playground windows are views of one owning runtime. HTTP continues
 * through the existing __site route; this channel carries tool commands only.
 */
const PROTOCOL = 'joomengine-runtime-view-v1';
const TOKEN = /^[a-zA-Z0-9_-]{16,128}$/;
const CALLS = new Set(['openDatabase', 'clearJoomlaCache', 'flush', 'exportSite', 'exportRecoveryFiles',
  'discoverConfiguration', 'captureConfiguration', 'getMcpConnection', 'updatePhpSettings',
  'switchPhpVersion', 'repairConfiguration', 'runPhp']);
const DEBUG = new Set(['start', 'setBreakpoints', 'continue', 'next', 'stepIn', 'stepOut', 'pause',
  'stop', 'stackTrace', 'scopes', 'variables', 'evaluate']);
const FILES = new Set(['mkdir', 'readFile', 'writeFile', 'readdir', 'stat', 'unlink']);
const ACTIONS = new Set(['start', 'stop', 'restart', 'reset', 'backup']);
const baseURL = () => new URL('../', import.meta.url).href;
const randomId = () => crypto.randomUUID().replaceAll('-', '');
const errorData = error => ({ name: error?.name || 'Error', message: error?.message || error?.name || 'The runtime operation failed.',
  ...(error?.code ? { code: error.code } : {}) });
const restoreError = value => Object.assign(new Error(value?.message || 'The runtime operation failed.'), value);
const activeKey = base => `joomengine-active-runtime-view:${new URL(base).pathname}`;
const channelName = (base, token) => `${PROTOCOL}:${new URL(base).pathname}:${token}`;
function checkedToken(token) {
  if (!TOKEN.test(token || '')) throw new TypeError('Invalid runtime view identity.');
  return token;
}
function subscribe(listeners, listener) {
  if (typeof listener !== 'function') throw new TypeError('A runtime listener is required.');
  listeners.add(listener); return () => listeners.delete(listener);
}
function emit(listeners, value) {
  for (const listener of listeners) { try { listener(value); } catch { /* A view cannot interrupt its owner. */ } }
}
function runtimeSnapshot(runtime, previous = null) {
  if (!runtime) return previous ? { ...previous, healthy: false, idle: true, closed: true, changing: false, stopped: true } : null;
  return {
    url: runtime.url, baseUrl: runtime.baseUrl, isolation: runtime.isolation,
    documentRoot: runtime.documentRoot, installMarkerPath: runtime.installMarkerPath,
    configuration: runtime.configuration, installation: runtime.installation,
    runtimeInfo: runtime.runtimeInfo, recovery: runtime.recovery,
    healthy: Boolean(runtime.healthy), closed: Boolean(runtime.closed), idle: Boolean(runtime.idle),
    changing: Boolean(runtime.changing), stopped: Boolean(runtime.closed),
    lastSavedAt: runtime.lastSavedAt, savedCurrentState: Boolean(runtime.savedCurrentState),
    persistencePending: Boolean(runtime.persistencePending), persistenceState: runtime.persistenceState,
    persistenceError: runtime.persistenceError ? errorData(runtime.persistenceError) : null,
    workspace: { id: runtime.workspace.id, storageId: runtime.workspace.storageId, root: runtime.workspace.root },
    debugger: { state: runtime.debugger.state, capabilities: runtime.debugger.capabilities },
  };
}

/** A companion URL contains only an opaque owner token and the chosen site path. */
export function runtimeViewURL({ token, path = '/', baseURL: base = baseURL() }) {
  checkedToken(token);
  const url = new URL(base);
  url.search = ''; url.hash = '';
  url.searchParams.set('view', token);
  const relative = String(path);
  if (!relative.startsWith('/') || relative.startsWith('//') || /[\\\0]/.test(relative)) throw new TypeError('Invalid site view path.');
  url.searchParams.set('viewPath', relative);
  return url.href;
}
export function readRuntimeViewURL(value = globalThis.location?.href) {
  const url = new URL(value);
  const token = url.searchParams.get('view');
  if (!token) return null;
  checkedToken(token);
  const path = url.searchParams.get('viewPath') || '/';
  runtimeViewURL({ token, path, baseURL: url });
  return { token, path };
}

/** A small discovery record is never a site snapshot and contains no credentials. */
export function readActiveRuntimeView({ storage = globalThis.localStorage, baseURL: base = baseURL() } = {}) {
  try {
    const value = JSON.parse(storage?.getItem(activeKey(base)) || 'null');
    if (!value || value.version !== 1 || !TOKEN.test(value.token || '')) return null;
    return { token: value.token, storageKey: value.storageKey, path: value.path || '/' };
  } catch { return null; }
}

export function createRuntimeViewHost({ getRuntime, onAction, onState = () => {}, onError = () => {}, token = randomId(),
  baseURL: base = baseURL(), storage = globalThis.localStorage,
  createChannel = name => new BroadcastChannel(name),
  setTimer = setTimeout, clearTimer = clearTimeout, heartbeatMs = 5000, batchTimeoutMs = 120_000 } = {}) {
  if (typeof getRuntime !== 'function') throw new TypeError('A runtime owner is required.');
  checkedToken(token);
  const channel = createChannel(channelName(base, token));
  const clients = new Set(), batches = new Map(), preparations = new Map();
  let disposed = false, current, lastSnapshot, unsubscribeWorkspace, unsubscribeDebug, heartbeat;
  const send = message => { if (!disposed) channel.postMessage({ protocol: PROTOCOL, ...message }); };
  const report = error => { try { onError(error); } catch {} };
  const publish = () => {
    if (disposed) return;
    const runtime = getRuntime();
    if (runtime !== current) {
      unsubscribeWorkspace?.(); unsubscribeDebug?.(); current = runtime;
      unsubscribeWorkspace = runtime?.workspace.subscribe(event => {
        send({ type: 'workspace', event });
        publish();
      });
      unsubscribeDebug = runtime?.debugger.subscribe(event => send({ type: 'debug', event }));
    }
    lastSnapshot = runtimeSnapshot(runtime, lastSnapshot);
    try { onState(lastSnapshot); } catch (error) { report(error); }
    send({ type: 'state', snapshot: lastSnapshot });
    try {
      if (lastSnapshot) storage?.setItem(activeKey(base), JSON.stringify({ version: 1, token,
        storageKey: lastSnapshot.configuration?.storageKey, path: '/' }));
    } catch { /* Discovery is optional; explicit companion URLs still work. */ }
    return lastSnapshot;
  };
  const requireRuntime = () => {
    const runtime = getRuntime();
    if (!runtime || runtime.closed) throw new Error('The live site is stopped. Start it in the Playground owner window.');
    return runtime;
  };
  function closeBatch(batch, error) {
    if (batch.finished) return;
    batch.finished = true; clearTimer(batch.timer);
    error ? batch.reject(error) : batch.resolve();
  }
  function ownBatch(id, clientId) {
    const batch = batches.get(id);
    if (!batch || batch.clientId !== clientId || batch.finished) throw new Error('The editor batch is no longer active.');
    return batch;
  }
  async function startBatch(clientId) {
    const runtime = requireRuntime(), id = randomId();
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const batch = { clientId, finished: false };
    batch.gate = new Promise((resolve, reject) => { batch.resolve = resolve; batch.reject = reject; });
    // A detached client must never leave the owner queue reserved indefinitely.
    batch.gate.catch(() => {});
    batches.set(id, batch);
    batch.operation = runtime.workspace.withBatch(async workspace => {
      batch.workspace = workspace;
      batch.timer = setTimer(() => closeBatch(batch, new Error('The editor batch timed out.')), batchTimeoutMs);
      readyResolve();
      return batch.gate;
    });
    batch.operation.catch(readyReject).finally(() => {
      clearTimer(batch.timer); batches.delete(id);
    }).catch(() => {});
    await ready;
    return id;
  }
  async function invoke(message) {
    const { method, args = [], clientId, id } = message;
    if (!Array.isArray(args)) throw new TypeError('Invalid runtime arguments.');
    if (method === 'action') {
      if (!ACTIONS.has(args[0]) || typeof onAction !== 'function') throw new Error('This site action is unavailable in a companion view.');
      await onAction(args[0], args[1], { clientId });
      return null;
    }
    if (method === 'batch.begin') return startBatch(clientId);
    if (method === 'batch.request') return ownBatch(args[0], clientId).workspace.request(args[1], args[2]);
    if (method === 'batch.end') {
      const batch = ownBatch(args[0], clientId);
      closeBatch(batch, args[1] ? restoreError(args[1]) : undefined);
      await batch.operation;
      return null;
    }
    const runtime = requireRuntime();
    if (method === 'workspace.request') return runtime.workspace.request(...args);
    if (method.startsWith('debugger.') && DEBUG.has(method.slice(9))) return runtime.debugger[method.slice(9)](...args);
    if (method.startsWith('fs.') && FILES.has(method.slice(3))) return runtime.fs[method.slice(3)](...args);
    if (method === 'request') {
      const response = await runtime.request(...args);
      return { status: response.status, statusText: response.statusText, headers: [...response.headers], body: await response.arrayBuffer() };
    }
    if (!CALLS.has(method) || typeof runtime[method] !== 'function') throw new Error('Unsupported runtime view operation.');
    if (method === 'exportSite') args[0] = { ...args[0], onProgress: event => send({ type: 'progress', clientId, id, event }) };
    return runtime[method](...args);
  }
  channel.onmessage = ({ data: message }) => {
    if (disposed || message?.protocol !== PROTOCOL || typeof message.clientId !== 'string') return;
    if (message.type === 'hello') {
      clients.add(message.clientId);
      send({ type: 'hello-result', clientId: message.clientId, snapshot: publish() });
    } else if (message.type === 'prepared') {
      const preparation = preparations.get(message.id);
      if (!preparation?.waiting.has(message.clientId)) return;
      preparation.waiting.delete(message.clientId);
      if (!message.ready) preparation.finish(false);
      else if (!preparation.waiting.size) preparation.finish(true);
    } else if (message.type === 'detach') {
      clients.delete(message.clientId);
      for (const preparation of preparations.values()) {
        preparation.waiting.delete(message.clientId);
        if (!preparation.waiting.size) preparation.finish(true);
      }
      for (const batch of batches.values()) if (batch.clientId === message.clientId) closeBatch(batch, new Error('The companion editor was closed.'));
    } else if (message.type === 'call' && clients.has(message.clientId) && typeof message.id === 'string') {
      Promise.resolve().then(() => invoke(message)).then(value => {
        send({ type: 'result', clientId: message.clientId, id: message.id, value });
      }, error => send({ type: 'result', clientId: message.clientId, id: message.id, error: errorData(error) }))
        .finally(() => publish()).catch(report);
    }
  };
  function scheduleHeartbeat() {
    heartbeat = setTimer(() => {
      if (disposed) return;
      send({ type: 'heartbeat' });
      scheduleHeartbeat();
    }, heartbeatMs);
    heartbeat?.unref?.();
  }
  publish(); scheduleHeartbeat();
  return {
    token, update: publish, getSnapshot: () => lastSnapshot,
    prepareTransition(action, { timeoutMs = 60_000 } = {}) {
      if (disposed) return Promise.resolve(false);
      if (!clients.size) return Promise.resolve(true);
      const id = randomId();
      return new Promise(resolve => {
        const preparation = { waiting: new Set(clients), timer: null,
          finish(ready) { clearTimer(preparation.timer); preparations.delete(id); resolve(ready); },
        };
        preparation.timer = setTimer(() => preparation.finish(false), timeoutMs);
        preparations.set(id, preparation);
        send({ type: 'prepare', id, action });
      });
    },
    url: path => runtimeViewURL({ token, path, baseURL: base }),
    get clients() { return clients.size; },
    dispose() {
      if (disposed) return;
      send({ type: 'gone' }); disposed = true;
      clearTimer(heartbeat); unsubscribeWorkspace?.(); unsubscribeDebug?.();
      for (const batch of batches.values()) closeBatch(batch, new Error('The runtime owner was closed.'));
      for (const preparation of preparations.values()) preparation.finish(false);
      try { if (JSON.parse(storage?.getItem(activeKey(base)) || 'null')?.token === token) storage.removeItem(activeKey(base)); } catch {}
      channel.close();
    },
  };
}

/** Attach tools to the owner; this never starts PHP, MariaDB, or a deployment. */
export async function attachRuntimeView({ token, baseURL: base = baseURL(), onState = () => {}, onUnavailable = () => {}, beforeTransition = async () => true,
  createChannel = name => new BroadcastChannel(name), setTimer = setTimeout, clearTimer = clearTimeout,
  connectTimeoutMs = 5000, requestTimeoutMs = 600_000, ownerTimeoutMs = 90_000 } = {}) {
  checkedToken(token);
  const channel = createChannel(channelName(base, token));
  const clientId = randomId(), pending = new Map(), workspaceListeners = new Set(), debugListeners = new Set();
  let snapshot, disposed = false, connected = false, unavailable = false, connectTimer, ownerTimer;
  let connectedResolve, connectedReject;
  const ready = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
  const send = message => channel.postMessage({ protocol: PROTOCOL, clientId, ...message });
  const notifyState = () => { try { onState(snapshot, { unavailable }); } catch {} };
  function markUnavailable() {
    if (disposed || unavailable) return;
    unavailable = true;
    clearTimer(ownerTimer);
    for (const task of pending.values()) { clearTimer(task.timer); task.reject(new Error('The runtime owner is no longer available.')); }
    pending.clear();
    // Keep editor buffers visible when the owner disappears unexpectedly. A
    // confirmed Stop emits workspace-closed; a lost connection is not consent
    // to discard unsaved text in the companion.
    emit(workspaceListeners, { type: 'workspace-unavailable', ownerUnavailable: true });
    notifyState();
    try { onUnavailable(snapshot); } catch {}
  }
  function call(method, args = [], { onProgress } = {}) {
    if (disposed || unavailable) return Promise.reject(new Error('The runtime owner is no longer available.'));
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => { pending.delete(id); reject(new Error('The runtime owner did not complete the operation in time.')); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer, onProgress });
      try { send({ type: 'call', id, method, args }); }
      catch (error) { clearTimer(timer); pending.delete(id); reject(error); }
    });
  }
  channel.onmessage = ({ data: message }) => {
    if (disposed || message?.protocol !== PROTOCOL || (message.clientId && message.clientId !== clientId)) return;
    if (message.type !== 'gone' && !unavailable) {
      clearTimer(ownerTimer);
      ownerTimer = setTimer(markUnavailable, ownerTimeoutMs);
      ownerTimer?.unref?.();
    }
    if (message.type === 'hello-result') {
      connected = true; snapshot = message.snapshot; clearTimer(connectTimer); connectedResolve(); notifyState();
    } else if (message.type === 'state') {
      snapshot = message.snapshot; if (connected) notifyState();
    } else if (message.type === 'prepare') {
      Promise.resolve().then(() => beforeTransition(message.action)).then(ready => {
        if (!disposed) send({ type: 'prepared', id: message.id, ready: Boolean(ready) });
      }, () => { if (!disposed) send({ type: 'prepared', id: message.id, ready: false }); });
    } else if (message.type === 'workspace') emit(workspaceListeners, message.event);
    else if (message.type === 'debug') emit(debugListeners, message.event);
    else if (message.type === 'gone') { if (!connected) connectedReject(new Error('The runtime owner is no longer available.')); markUnavailable(); }
    else if (message.type === 'progress') { try { pending.get(message.id)?.onProgress?.(message.event); } catch {} }
    else if (message.type === 'result') {
      const task = pending.get(message.id);
      if (!task) return;
      clearTimer(task.timer); pending.delete(message.id);
      message.error ? task.reject(restoreError(message.error)) : task.resolve(message.value);
    }
  };
  connectTimer = setTimer(() => connectedReject(new Error('The running site could not be reached. Open its original Playground window or resume its saved site.')), connectTimeoutMs);
  send({ type: 'hello' });
  try { await ready; }
  catch (error) { clearTimer(connectTimer); clearTimer(ownerTimer); channel.close(); throw error; }
  const workspace = {
    get id() { return snapshot?.workspace.id; },
    get storageId() { return snapshot?.workspace.storageId; },
    get root() { return snapshot?.workspace.root || '/'; },
    request: (operation, args) => call('workspace.request', [operation, args]),
    subscribe: listener => subscribe(workspaceListeners, listener),
    async withBatch(callback) {
      if (typeof callback !== 'function') throw new TypeError('A workspace batch callback is required.');
      const id = await call('batch.begin');
      let value, failure;
      try { value = await callback({ ...workspace, withBatch: undefined, request: (operation, args) => call('batch.request', [id, operation, args]) }); }
      catch (error) { failure = error; }
      try { await call('batch.end', [id, failure ? errorData(failure) : null]); }
      catch (error) { failure ||= error; }
      if (failure) throw failure;
      return value;
    },
  };
  const proxy = {
    companion: true, isRemoteView: true, workspace,
    get healthy() { return !disposed && !unavailable && Boolean(snapshot?.healthy); },
    get closed() { return disposed || unavailable || Boolean(snapshot?.closed); },
    get idle() { return Boolean(snapshot?.idle); },
    get changing() { return Boolean(snapshot?.changing); },
    get persistenceError() { return snapshot?.persistenceError ? restoreError(snapshot.persistenceError) : null; },
    get debugger() { return debuggerProxy; },
    action: (name, args) => call('action', [name, args]),
    close: () => call('action', ['stop']), reset: () => call('action', ['reset']),
    keep: async () => proxy,
    exportSite(options = {}) { const { onProgress, ...settings } = options; return call('exportSite', [settings], { onProgress }); },
    async request(path, init) {
      const response = await call('request', [path, init]);
      return new Response([204, 205, 304].includes(response.status) ? null : response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
    fs: Object.fromEntries([...FILES].map(method => [method, (...args) => call(`fs.${method}`, args)])),
    dispose() {
      if (disposed) return;
      try { send({ type: 'detach' }); } catch {}
      disposed = true; clearTimer(ownerTimer); channel.close();
      for (const task of pending.values()) { clearTimer(task.timer); task.reject(new Error('The companion view was closed.')); }
      pending.clear(); workspaceListeners.clear(); debugListeners.clear();
    },
  };
  for (const name of ['url', 'baseUrl', 'isolation', 'documentRoot', 'installMarkerPath', 'configuration', 'installation',
    'runtimeInfo', 'recovery', 'lastSavedAt', 'savedCurrentState', 'persistencePending', 'persistenceState']) {
    Object.defineProperty(proxy, name, { enumerable: true, get: () => name === 'configuration' ? structuredClone(snapshot?.[name]) : snapshot?.[name] });
  }
  for (const method of CALLS) if (!(method in proxy)) proxy[method] = (...args) => call(method, args);
  const debuggerProxy = { get state() { return snapshot?.debugger.state || 'idle'; },
    get capabilities() { return snapshot?.debugger.capabilities || {}; },
    subscribe: listener => subscribe(debugListeners, listener),
    ...Object.fromEntries([...DEBUG].map(method => [method, (...args) => call(`debugger.${method}`, args)])),
  };
  return proxy;
}
