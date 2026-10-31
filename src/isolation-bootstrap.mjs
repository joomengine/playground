import { ISOLATION_BOOTSTRAP_VERSION, isolationMarker, isolationNavigationURL, ownedClientURL } from './isolation.mjs';

const timeout = (message, milliseconds, reject) => setTimeout(() => reject(new Error(message)), milliseconds);
const stateKey = baseURL => `joomengine:isolation-bootstrap:${new URL(baseURL).href}`;

export function validateCompatibilityConfiguration(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.fallbackEnabled !== 'boolean'
    || Object.keys(value).some(key => !['schemaVersion', 'fallbackEnabled'].includes(key))) {
    throw new TypeError('Invalid browser compatibility deployment configuration.');
  }
  return Object.freeze({ schemaVersion: 1, fallbackEnabled: value.fallbackEnabled });
}

export function readBootstrapState(storage, baseURL) {
  let value;
  try { value = JSON.parse(storage.getItem(stateKey(baseURL)) || 'null'); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw new Error('Session storage is unavailable. Allow it for this page so browser isolation can start without reload loops.');
  }
  if (value?.version !== ISOLATION_BOOTSTRAP_VERSION || !Array.isArray(value.attempted)
    || value.attempted.length > 2 || value.attempted.some(policy => !['credentialless', 'require-corp'].includes(policy))
    || !['pending', 'ready', 'failed'].includes(value.phase)) {
    return { version: ISOLATION_BOOTSTRAP_VERSION, attempted: [], takeover: false, phase: 'pending' };
  }
  return { version: value.version, attempted: [...new Set(value.attempted)], takeover: value.takeover === true, phase: value.phase };
}

function writeBootstrapState(storage, baseURL, value) {
  try { storage.setItem(stateKey(baseURL), JSON.stringify(value)); }
  catch { throw new Error('Session storage is unavailable. Browser isolation stopped before reloading; no saved site was changed.'); }
}

/** A bounded state machine: first controlled takeover, then at most one fallback. */
export function nextIsolationAttempt({ url, state, verified, failure, fallbackEnabled, embedded = false }) {
  const marker = isolationMarker(url);
  const current = marker?.version === ISOLATION_BOOTSTRAP_VERSION ? marker.policy : null;
  const next = { ...state, attempted: [...state.attempted] };
  const fail = message => ({ error: message, state: { ...next, phase: 'failed' } });
  const navigate = (policy, reason) => {
    if (!next.attempted.includes(policy)) next.attempted.push(policy);
    next.phase = 'pending';
    return { reloadRequired: true, reloadURL: isolationNavigationURL(url, policy), policy, reason, state: next };
  };
  if (!current) {
    if (next.phase === 'ready') { next.attempted = []; next.takeover = false; }
    if (next.takeover) return fail('The controlled isolation navigation did not retain its bootstrap marker. The host may be redirecting or removing query parameters. Open Playground directly over HTTPS; no saved site was changed.');
    next.takeover = true;
    return navigate('credentialless', 'Establishing the controlling service worker and normal browser isolation.');
  }
  if (current === 'require-corp' && !fallbackEnabled) {
    return fail('This browser needs require-corp compatibility mode, but that fallback is disabled for this deployment. Normal credentialless mode is unchanged. No saved site was changed.');
  }
  if (!next.attempted.includes(current)) next.attempted.push(current);
  if (verified) return { reloadRequired: false, policy: current, mode: current === 'require-corp' ? 'compatibility' : 'normal', state: { ...next, phase: 'ready' } };
  if (next.phase === 'failed') return fail(`Browser isolation remains unavailable: ${failure} No automatic reload was repeated; no saved site was changed.`);
  if (current === 'credentialless' && fallbackEnabled && !next.attempted.includes('require-corp')) {
    return navigate('require-corp', 'Normal isolation was unavailable; trying the require-corp compatibility policy.');
  }
  const context = embedded
    ? ' Open Playground directly in a top-level tab. An embedded Playground also requires compatible isolation on its parent page.'
    : ' Check HTTPS, service-worker permissions, response headers and browser shared-memory support.';
  return fail(`${current === 'credentialless' && !fallbackEnabled ? 'Normal isolation is unavailable and compatibility fallback is disabled.' : 'The selected browser isolation policies could not establish the required environment.'} ${failure}${context} No saved site was changed.`);
}

async function workerHandshake(serviceWorker, expectedScriptURL) {
  const controller = serviceWorker.controller;
  if (!controller || controller.scriptURL !== expectedScriptURL) throw new Error('The correct Playground service worker does not control this page.');
  const channel = new MessageChannel();
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = timeout('The controlling service worker did not identify its bootstrap version.', 1500, reject);
      channel.port1.onmessage = event => {
        const value = event.data;
        if (value?.bootstrapVersion !== ISOLATION_BOOTSTRAP_VERSION || typeof value.clientId !== 'string') {
          reject(new Error('The controlling service worker is from an older Playground build.'));
        } else resolve(value);
      };
      controller.postMessage({ type: 'playground-environment' }, [channel.port2]);
    });
  } finally { clearTimeout(timer); channel.port1.close(); channel.port2.close(); }
}

/** Confirm a particular controller version, not just the existence of a controller. */
export async function establishServiceWorker(baseURL, serviceWorker = navigator.serviceWorker) {
  const scriptURL = new URL('service-worker.mjs', baseURL).href;
  const registration = await serviceWorker.register(scriptURL, { type: 'module', scope: new URL(baseURL).pathname, updateViaCache: 'none' });
  const pending = registration.installing ?? registration.waiting;
  if (pending && pending.state !== 'activated') await new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timer); pending.removeEventListener('statechange', changed); error ? reject(error) : resolve(); };
    const changed = () => {
      if (pending.state === 'activated') done();
      if (pending.state === 'redundant') done(new Error('The Playground service worker could not activate.'));
    };
    const timer = timeout('Service-worker activation timed out.', 30_000, error => done(error));
    pending.addEventListener('statechange', changed); changed();
  });
  const deadline = Date.now() + 30_000;
  let last;
  do {
    try { return await workerHandshake(serviceWorker, scriptURL); }
    catch (error) { last = error; }
    // Activation/claim is asynchronous. Event plus timer also handles an update
    // whose controllerchange occurred just before the listener was attached.
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); serviceWorker.removeEventListener('controllerchange', finish); resolve(); };
      const timer = setTimeout(finish, 200);
      serviceWorker.addEventListener('controllerchange', finish, { once: true });
    });
  } while (Date.now() < deadline);
  throw last;
}

export async function verifySharedMemoryEnvironment({ baseURL, ownerId, global = globalThis }) {
  if (global.crossOriginIsolated !== true) return { ok: false, reason: 'crossOriginIsolated is false.' };
  if (typeof global.SharedArrayBuffer !== 'function' || typeof global.Atomics?.add !== 'function') return { ok: false, reason: 'SharedArrayBuffer or Atomics is unavailable.' };
  if (typeof global.Worker !== 'function' || typeof global.WebAssembly?.Memory !== 'function') return { ok: false, reason: 'Dedicated workers or WebAssembly memory is unavailable.' };
  let worker, timer;
  try {
    const memory = new global.WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    if (!(memory.buffer instanceof global.SharedArrayBuffer)) throw new Error('WebAssembly shared memory is not usable.');
    worker = new global.Worker(ownedClientURL(new URL('src/isolation-probe.mjs', baseURL), { baseURL, ownerId }), { type: 'module', name: 'joomengine-isolation-probe' });
    await new Promise((resolve, reject) => {
      timer = timeout('Shared-memory module-worker verification timed out.', 12_000, reject);
      worker.onmessage = event => event.data?.ok && event.data.value === 2 && Atomics.load(new Int32Array(memory.buffer), 0) === 2
        ? resolve() : reject(new Error(event.data?.error || 'Workers could not exchange shared WebAssembly memory.'));
      worker.onerror = event => reject(new Error(event.message || 'Module workers are blocked by the browser or hosting policy.'));
      worker.onmessageerror = () => reject(new Error('The browser could not exchange shared memory with its worker.'));
      worker.postMessage({ memory });
    });
    return { ok: true };
  } catch (error) { return { ok: false, reason: error.message }; }
  finally { clearTimeout(timer); worker?.terminate(); }
}

export async function prepareBrowserIsolation({ baseURL, global = globalThis, fetcher = fetch } = {}) {
  const navigator = global.navigator;
  if (!global.isSecureContext || !navigator?.serviceWorker) throw new Error('The playground needs HTTPS or localhost and service-worker support.');
  if (!navigator.locks?.request || !global.indexedDB) throw new Error('This browser does not provide IndexedDB and Web Locks required by the playground. No saved site was changed.');
  const identity = await establishServiceWorker(baseURL, navigator.serviceWorker);
  let configuration = { schemaVersion: 1, fallbackEnabled: false }, configurationFailure;
  try {
    const response = await fetcher(new URL('config/browser-compatibility.json', baseURL), { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    configuration = validateCompatibilityConfiguration(await response.json());
  } catch (error) { configurationFailure = `Compatibility configuration is unavailable (${error.message}); fallback is disabled.`; }
  const state = readBootstrapState(global.sessionStorage, baseURL);
  const verified = await verifySharedMemoryEnvironment({ baseURL, ownerId: identity.clientId, global });
  const result = nextIsolationAttempt({ url: global.location.href, state, verified: verified.ok,
    failure: verified.reason || '', fallbackEnabled: configuration.fallbackEnabled, embedded: global.parent !== global });
  writeBootstrapState(global.sessionStorage, baseURL, result.state);
  if (result.error) throw new Error([result.error, configurationFailure].filter(Boolean).join(' '));
  return Object.freeze({ ...result, clientId: identity.clientId, ownerId: identity.clientId,
    bootstrapVersion: ISOLATION_BOOTSTRAP_VERSION, configuration, diagnostic: configurationFailure });
}
