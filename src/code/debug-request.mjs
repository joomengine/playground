const HTTP_METHOD = /^[!#$%&'*+.^_`|~0-9A-Z-]+$/;
const MAX_QUEUE = 64;

function debugError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function siteBoundary(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('The debugger requires an HTTP site URL without credentials, query or fragment.');
  }
  if (!url.pathname.endsWith('/')) throw new TypeError('The debugger site URL must end in a slash.');
  return url;
}

function requestURL(value, site) {
  if (typeof value !== 'string' || !value || value.includes('#')) throw new TypeError('A request URL without a fragment is required.');
  const url = new URL(value, site);
  if (url.origin !== site.origin || !url.pathname.startsWith(site.pathname) || url.username || url.password) {
    throw new TypeError('The debug request must belong to the active site.');
  }
  return url;
}

function method(value) {
  if (typeof value !== 'string' || !value || !HTTP_METHOD.test(value.toUpperCase())) {
    throw new TypeError('An explicit HTTP method is required.');
  }
  return value.toUpperCase();
}

/**
 * Match one exact URL (including its query) and method, with optional exact
 * headers/destination. No regular expressions or wildcard matching are used.
 * A destination restriction fails closed when the transport did not supply it.
 */
export function createDebugRequestMatcher({ siteURL, url, method: requestMethod, headers = [], destination } = {}) {
  const site = siteBoundary(siteURL);
  const target = requestURL(url, site).href;
  const targetMethod = method(requestMethod);
  const expectedHeaders = [...new Headers(headers)];
  if (destination !== undefined && (typeof destination !== 'string' || !/^[a-z-]*$/.test(destination))) {
    throw new TypeError('The request destination must be an exact browser destination string.');
  }
  return request => {
    try {
      if (!request || method(request.method) !== targetMethod || requestURL(request.url, site).href !== target) return false;
      const receivedHeaders = new Headers(request.headers || []);
      if (expectedHeaders.some(([name, value]) => receivedHeaders.get(name) !== value)) return false;
      if (destination !== undefined && (request.destination ?? receivedHeaders.get('sec-fetch-dest')) !== destination) return false;
      return true;
    } catch { return false; }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

function duration(value, name) {
  if (!Number.isInteger(value) || value < 10 || value > 600_000) throw new RangeError(`${name} must be between 10 and 600000 milliseconds.`);
  return value;
}

function bounded(promise, milliseconds, error) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(error), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Serialize site execution and writes around one selected debug request.
 *
 * All request/mutation paths for the site must use this coordinator. The owner
 * retains the filesystem/database and passes a debugger backend which implements:
 *
 * - debugRequest(request, hooks): return the real HTTP response, settling only
 *   after request teardown and filesystem/database handoff have completed.
 * - debugControl(command, args): send a debugger command independently of the
 *   request queue. A stop command should end the request without replaying it.
 * - terminateDebug({ reason }): terminate an unresponsive debug runtime and
 *   complete recovery/handoff before resolving. Reject if safe recovery failed.
 *
 * The backend calls hooks.started(), hooks.paused(), hooks.resumed() from real
 * runtime events. It must honor hooks.signal during startup, and prevent a late
 * startup continuation from launching PHP after cancellation. This module does
 * not manufacture a response, emulate a debugger, or retry any request.
 */
export class DebugRequestCoordinator {
  #site;
  #normalRequest;
  #debugRequest;
  #debugControl;
  #terminateDebug;
  #onState;
  #startupTimeout;
  #stopTimeout;
  #requestTimeout;
  #queue = Promise.resolve();
  #queued = 0;
  #selection = null;
  #reservation = null;
  #active = null;
  #failure = null;
  #closing = false;
  #closed = false;
  #state = 'idle';

  constructor({ siteURL, normalRequest, debugRequest, debugControl, terminateDebug,
    onState = () => {}, startupTimeoutMs = 30_000, stopTimeoutMs = 10_000, requestTimeoutMs = 180_000 } = {}) {
    this.#site = siteBoundary(siteURL);
    for (const [name, callback] of Object.entries({ normalRequest, debugRequest, debugControl, terminateDebug, onState })) {
      if (typeof callback !== 'function') throw new TypeError(`${name} must be a function.`);
    }
    this.#normalRequest = normalRequest;
    this.#debugRequest = debugRequest;
    this.#debugControl = debugControl;
    this.#terminateDebug = terminateDebug;
    this.#onState = onState;
    this.#startupTimeout = duration(startupTimeoutMs, 'startupTimeoutMs');
    this.#stopTimeout = duration(stopTimeoutMs, 'stopTimeoutMs');
    this.#requestTimeout = duration(requestTimeoutMs, 'requestTimeoutMs');
  }

  get state() { return this.#state; }
  get paused() { return this.#state === 'paused'; }
  get queued() { return this.#queued; }

  #assertOpen() {
    if (this.#failure) throw this.#failure;
    if (this.#closing || this.#closed) throw debugError('The debug session is closed.', 'DEBUG_CLOSED');
  }

  #setState(state, error) {
    this.#state = state;
    // Observers cannot fail a PHP request or release its lock accidentally.
    try { this.#onState({ state, queued: this.#queued, ...(error ? { error } : {}) }); } catch { /* UI observer only. */ }
  }

  arm(selection) {
    this.#assertOpen();
    if (this.#reservation || this.#active) throw debugError('A debug request is already selected or running.', 'DEBUG_BUSY');
    this.#selection = createDebugRequestMatcher({ ...selection, siteURL: this.#site.href });
    this.#setState('armed');
  }

  #enqueue(callback) {
    this.#assertOpen();
    if (this.#queued >= MAX_QUEUE) throw debugError('The PHP request queue is full.', 'DEBUG_QUEUE_FULL');
    this.#queued++;
    const result = this.#queue.then(() => { this.#assertOpen(); return callback(); }).finally(() => { this.#queued--; });
    this.#queue = result.catch(() => {});
    return result;
  }

  request(request) {
    try {
      this.#assertOpen();
      requestURL(request?.url, this.#site);
      method(request?.method);
      // Check queue capacity before consuming the one-shot selection.
      if (this.#queued >= MAX_QUEUE) throw debugError('The PHP request queue is full.', 'DEBUG_QUEUE_FULL');
      const selected = this.#selection?.(request) === true;
      let reservation;
      if (selected) {
        reservation = { error: null };
        this.#selection = null;
        this.#reservation = reservation;
      }
      const result = this.#enqueue(async () => {
        if (!selected) return this.#normalRequest(request);
        if (reservation.error) throw reservation.error;
        return this.#runDebug(request, reservation);
      });
      if (selected) this.#setState('queued');
      return result;
    } catch (error) { return Promise.reject(error); }
  }

  /** A save batch or persistence operation occupies one indivisible queue slot. */
  mutate(callback) {
    if (typeof callback !== 'function') return Promise.reject(new TypeError('A site mutation callback is required.'));
    try { return this.#enqueue(callback); } catch (error) { return Promise.reject(error); }
  }

  /** Control never waits behind a paused request, queued writes or other requests. */
  async control(command, args = {}) {
    this.#assertOpen();
    if (typeof command !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(command)) throw new TypeError('Invalid debugger command.');
    if (command === 'stop') return this.stop();
    if (this.#state === 'stopping') throw debugError('The debug request is stopping.', 'DEBUG_STOPPING');
    return this.#debugControl(command, args);
  }

  #clearTimers(active) {
    clearTimeout(active.startupTimer);
    clearTimeout(active.executionTimer);
    active.startupTimer = active.executionTimer = null;
  }

  #runTimer(active) {
    if (active !== this.#active || active.stopError) return;
    clearTimeout(active.executionTimer);
    active.runningSince = performance.now();
    active.executionTimer = setTimeout(() => {
      void this.stop(debugError('The debug request exceeded its execution timeout; it was not replayed.', 'DEBUG_TIMEOUT')).catch(() => {});
    }, Math.max(1, active.remaining));
  }

  async #runDebug(request, reservation) {
    const active = { controller: new AbortController(), cancelled: deferred(), remaining: this.#requestTimeout,
      runningSince: null, executionTimer: null, startupTimer: null, stopError: null, stopPromise: null };
    this.#active = active;
    this.#reservation = null;
    const live = () => this.#active === active && !active.stopError;
    const started = () => {
      if (!live() || this.#state !== 'starting') return;
      clearTimeout(active.startupTimer); active.startupTimer = null;
      this.#setState('running'); this.#runTimer(active);
    };
    const paused = () => {
      if (!live() || !['starting', 'running'].includes(this.#state)) return;
      if (active.runningSince !== null) active.remaining -= performance.now() - active.runningSince;
      active.runningSince = null;
      this.#clearTimers(active);
      this.#setState('paused');
    };
    const resumed = () => {
      if (!live() || this.#state !== 'paused') return;
      this.#setState('running'); this.#runTimer(active);
    };
    active.startupTimer = setTimeout(() => {
      void this.stop(debugError('PHP debugger startup timed out; the request was not replayed.', 'DEBUG_STARTUP_TIMEOUT')).catch(() => {});
    }, this.#startupTimeout);
    active.execution = Promise.resolve().then(() => {
      if (active.controller.signal.aborted) throw active.controller.signal.reason;
      return this.#debugRequest(request, { signal: active.controller.signal, started, paused, resumed });
    });
    this.#setState('starting');
    // The loser of the race remains observed, even after forced termination.
    try {
      const result = await Promise.race([
        active.execution,
        active.cancelled.promise.then(error => { throw error; }),
      ]);
      if (active.stopError) throw active.stopError;
      return result;
    } finally {
      this.#clearTimers(active);
      if (active.stopPromise) await active.stopPromise.catch(() => {});
      if (this.#active === active) this.#active = null;
      if (this.#reservation === reservation) this.#reservation = null;
      this.#setState(this.#failure ? 'failed' : this.#closing || this.#closed ? 'closed' : 'idle');
    }
  }

  /** Cancel an arm/selection, or stop the active request without normal replay. */
  async stop(reason = debugError('The debug request was stopped; it was not replayed. Completed database writes remain.', 'DEBUG_STOPPED')) {
    const error = reason instanceof Error ? reason : debugError(String(reason), 'DEBUG_STOPPED');
    this.#selection = null;
    if (this.#reservation) { this.#reservation.error = error; this.#reservation = null; }
    const active = this.#active;
    if (!active) {
      if (!this.#failure && !this.#closed) this.#setState(this.#closing ? 'closed' : 'idle');
      return false;
    }
    if (active.stopPromise) return active.stopPromise;
    active.stopError = error;
    this.#clearTimers(active);
    this.#setState('stopping');
    active.controller.abort(error);
    active.stopPromise = (async () => {
      // Send stop immediately. A stuck command must not block the recovery path.
      Promise.resolve().then(() => this.#debugControl('stop', {})).catch(() => {});
      const settled = active.execution.then(() => true, () => true);
      try {
        try {
          await bounded(settled, this.#stopTimeout, debugError('PHP did not stop within the deadline.', 'DEBUG_STOP_TIMEOUT'));
        } catch {
          await bounded(Promise.resolve().then(() => this.#terminateDebug({ reason: error })), this.#stopTimeout,
            debugError('PHP debugger recovery timed out; restart the site before executing more requests.', 'DEBUG_RECOVERY_TIMEOUT'));
        }
        active.cancelled.resolve(error);
        return true;
      } catch (failure) {
        // Do not let queued filesystem or DB work race an unconfirmed runtime.
        this.#failure = debugError(`PHP debugger recovery failed: ${failure.message}. Queued operations were cancelled; no request was replayed.`, 'DEBUG_RECOVERY_FAILED');
        this.#failure.cause = failure;
        active.cancelled.resolve(this.#failure);
        this.#setState('failed', this.#failure);
        throw this.#failure;
      }
    })();
    return active.stopPromise;
  }

  async close() {
    if (this.#closed) return;
    this.#closing = true;
    try { await this.stop(); await this.#queue; }
    finally { this.#closed = true; this.#setState(this.#failure ? 'failed' : 'closed'); }
    if (this.#failure) throw this.#failure;
  }
}
