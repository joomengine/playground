import { normalizeNetworkConfig } from './network-config.mjs';

const SESSION_WAIT_MS = 120_000;
const RENEW_BEFORE_MS = 60_000;
const MAX_SESSION_BYTES = 16 * 1024;
const sessionError = (code, message) => Object.assign(new Error(message), { code });
const aborted = () => sessionError('REQUEST_ABORTED', 'Network verification was cancelled.');

/** Only the application host, never imported site configuration, grants local development access. */
export function isLocalNetworkDevelopment(value) {
  const url = new URL(value);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

async function boundedText(response, limit = MAX_SESSION_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); throw sessionError('RELAY_UNAVAILABLE', 'The network service response was too large.'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let length = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw sessionError('RELAY_UNAVAILABLE', 'The network service response was too large.'); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export async function loadNetworkConfiguration(baseURL, fetcher = globalThis.fetch.bind(globalThis)) {
  const response = await fetcher(new URL('config/network.json', baseURL), {
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw sessionError('RELAY_UNAVAILABLE', 'The network service configuration could not be loaded.');
  const text = await boundedText(response);
  return normalizeNetworkConfig(JSON.parse(text), { allowInsecureLocalhost: isLocalNetworkDevelopment(baseURL) });
}

function validateSession(value, now) {
  if (value?.version !== 1 || typeof value.token !== 'string' || !/^[A-Za-z0-9._~-]{16,4096}$/.test(value.token)
    || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 31 * 60_000) {
    throw sessionError('RELAY_UNAVAILABLE', 'The network service returned an invalid session.');
  }
  return Object.freeze({ token: value.token, expiresAt: value.expiresAt });
}

function waitFor(promise, signal, deadline, now = Date.now) {
  if (signal?.aborted) return Promise.reject(aborted());
  const remaining = Math.min(SESSION_WAIT_MS, Number.isFinite(deadline) ? deadline - now() : SESSION_WAIT_MS);
  if (remaining <= 0) return Promise.reject(sessionError('UPSTREAM_TIMEOUT', 'The network request deadline expired.'));
  return new Promise((resolve, reject) => {
    const cancel = () => finish(aborted());
    const timer = setTimeout(() => finish(sessionError('UPSTREAM_TIMEOUT', 'Network verification timed out.')), remaining);
    function finish(error, value) {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value);
    }
    signal?.addEventListener('abort', cancel, { once: true });
    promise.then(value => finish(null, value), finish);
  });
}

/** In-memory relay sessions belong to the shell, outside the blocked PHP queue. */
export function createNetworkSession(config, { fetcher = globalThis.fetch.bind(globalThis), verify, now = Date.now } = {}) {
  let current, flight, disposed = false;
  async function exchange(signal) {
    if (!config.enabled) throw sessionError('RELAY_SESSION_REQUIRED', 'The network service is disabled.');
    const previous = current;
    // An expired session is deliberately retained: obtaining a fresh session here
    // would silently reset the server's cumulative quota.
    if (previous && previous.expiresAt <= now()) throw sessionError('RELAY_SESSION_EXPIRED', 'The network session expired. Open a new Playground session to verify again.');
    const turnstileToken = previous ? undefined : await verify({ signal });
    if (signal.aborted) throw aborted();
    const response = await fetcher(new URL('v1/session', `${config.endpoint.replace(/\/+$/, '')}/`), {
      method: 'POST', credentials: 'omit', mode: 'cors', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(previous ? { Authorization: `Bearer ${previous.token}` } : {}) },
      body: JSON.stringify({ version: 1, ...(turnstileToken ? { turnstileToken } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    const body = await boundedText(response);
    let value;
    try { value = JSON.parse(body); } catch { throw sessionError('RELAY_UNAVAILABLE', 'The network service returned an invalid session response.'); }
    if (!response.ok) {
      const code = /^[A-Z_]{3,60}$/.test(value?.error?.code || '') ? value.error.code : 'RELAY_UNAVAILABLE';
      const error = sessionError(code, code === 'RATE_LIMITED' ? 'The network service usage limit was reached. Please try again later.' : 'The network service could not authorize this session.');
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }
    if (signal.aborted || disposed) throw aborted();
    current = validateSession(value, now());
    return current;
  }
  return {
    async getSession({ signal, deadline = Infinity } = {}) {
      if (disposed || signal?.aborted) throw aborted();
      if (current && current.expiresAt - now() > RENEW_BEFORE_MS) return current;
      if (!flight) {
        const controller = new AbortController();
        const pending = { controller, users: 0 };
        pending.promise = exchange(controller.signal).finally(() => { if (flight === pending) flight = undefined; });
        // A caller can abort before the server settles; retain a rejection handler.
        pending.promise.catch(() => {});
        flight = pending;
      }
      const pending = flight;
      pending.users++;
      try { return await waitFor(pending.promise, signal, deadline, now); }
      finally { if (--pending.users === 0 && flight === pending) pending.controller.abort(); }
    },
    dispose() { disposed = true; current = undefined; flight?.controller.abort(); },
  };
}

/** RPC uses a separate message lane so verification cannot deadlock behind PHP. */
export function createNetworkSessionClient(send, { now = Date.now } = {}) {
  const pending = new Map();
  return {
    getSession({ signal, deadline = Infinity } = {}) {
      if (signal?.aborted) return Promise.reject(aborted());
      const id = crypto.randomUUID();
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      pending.set(id, { resolve, reject });
      send({ type: 'network-session-request', id, deadline: Number.isFinite(deadline) ? deadline : now() + SESSION_WAIT_MS });
      return waitFor(promise, signal, deadline, now).finally(() => {
        if (pending.delete(id)) send({ type: 'network-session-cancel', id });
      });
    },
    receive(message) {
      if (message?.type !== 'network-session-result') return false;
      const entry = pending.get(message.id);
      if (!entry) return true;
      pending.delete(message.id);
      if (message.error) entry.reject(sessionError(message.code || 'RELAY_SESSION_REQUIRED', String(message.error)));
      else {
        try { entry.resolve(validateSession({ version: 1, ...message.value }, now())); }
        catch (error) { entry.reject(error); }
      }
      return true;
    },
    dispose() { for (const entry of pending.values()) entry.reject(aborted()); pending.clear(); },
  };
}

export function createNetworkSessionHost(service, send) {
  const pending = new Map();
  return {
    receive(message) {
      if (message?.type === 'network-session-cancel') { pending.get(message.id)?.abort(); return true; }
      if (message?.type !== 'network-session-request') return false;
      if (typeof message.id !== 'string' || !/^[\w-]{1,80}$/.test(message.id) || pending.has(message.id)) return true;
      if (pending.size >= 4) {
        send({ type: 'network-session-result', id: message.id, error: 'Too many network verification requests.', code: 'RATE_LIMITED' });
        return true;
      }
      const controller = new AbortController();
      pending.set(message.id, controller);
      const deadline = Math.min(Date.now() + SESSION_WAIT_MS, Number.isFinite(message.deadline) ? message.deadline : Infinity);
      void Promise.resolve().then(() => service.getSession({ signal: controller.signal, deadline })).then(
        value => { if (!controller.signal.aborted) send({ type: 'network-session-result', id: message.id, value }); },
        error => { if (!controller.signal.aborted) send({ type: 'network-session-result', id: message.id,
          error: error.message || 'Network verification failed.', code: error.code || 'RELAY_SESSION_REQUIRED' }); },
      ).finally(() => { pending.delete(message.id); });
      return true;
    },
    dispose() { for (const controller of pending.values()) controller.abort(); pending.clear(); },
  };
}

/** Never include URLs, query strings, tokens, bodies or arbitrary error messages. */
export function networkDiagnosticText(value) {
  const fields = [];
  for (const key of ['code', 'route', 'method', 'hostname', 'status', 'durationMs', 'bytes']) {
    const field = value?.[key];
    if (typeof field === 'number' && Number.isFinite(field)) fields.push(`${key}: ${field}`);
    else if (typeof field === 'string' && /^[a-zA-Z0-9_.:-]{1,253}$/.test(field)) fields.push(`${key}: ${field}`);
  }
  return fields.join('\n');
}

export function showNetworkDiagnostic(value, document = globalThis.document) {
  if (!document?.body || !value?.code) return;
  let notice = document.getElementById('network-service-diagnostic');
  if (!notice) {
    notice = document.createElement('details'); notice.id = 'network-service-diagnostic'; notice.setAttribute('role', 'status');
    Object.assign(notice.style, { position: 'fixed', bottom: '1rem', right: '1rem', zIndex: '10000', maxWidth: '32rem', padding: '1rem', background: 'Canvas', color: 'CanvasText', border: '1px solid GrayText', borderRadius: '.5rem', boxShadow: '0 4px 20px #0003' });
    const summary = document.createElement('summary'); summary.textContent = 'The network request could not be completed. Your site remains available.';
    const detail = document.createElement('pre'); detail.style.whiteSpace = 'pre-wrap';
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; dismiss.addEventListener('click', () => notice.remove());
    notice.append(summary, detail, dismiss); document.body.append(notice);
  }
  notice.querySelector('pre').textContent = networkDiagnosticText(value);
}

/** A user-opened, non-isolated popup can render Turnstile under either COEP mode. */
export function requestNetworkVerification(baseURL, { signal, document = globalThis.document, window = globalThis.window, Channel = globalThis.BroadcastChannel } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  if (!document?.body || typeof Channel !== 'function') return Promise.reject(sessionError('RELAY_SESSION_REQUIRED', 'Open Playground in a browser that supports network verification.'));
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const channel = new Channel(`joomengine-network-${nonce}`);
    const dialog = document.createElement('dialog');
    const title = document.createElement('h2'); title.textContent = 'Verify network access';
    const description = document.createElement('p'); description.textContent = 'This request needs the configured network service. Verify in a separate window to continue.';
    const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Verify network access';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel request';
    let popup, finished = false;
    const timeout = setTimeout(() => finish(sessionError('UPSTREAM_TIMEOUT', 'Network verification timed out.')), SESSION_WAIT_MS);
    const abort = () => finish(aborted());
    function finish(error, token) {
      if (finished) return; finished = true;
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      channel.postMessage({ type: error ? 'cancel' : 'complete' }); channel.close();
      try { popup?.close(); } catch { /* COOP may sever the WindowProxy. */ }
      dialog.close(); dialog.remove();
      if (error) reject(error); else resolve(token);
    }
    channel.onmessage = event => {
      const message = event.data;
      if (message?.type === 'verified' && typeof message.token === 'string' && message.token.length > 0 && message.token.length <= 2048) finish(null, message.token);
      else if (message?.type === 'failed') finish(sessionError('RELAY_SESSION_REQUIRED', 'Network verification could not be completed.'));
    };
    open.addEventListener('click', () => {
      const url = new URL('network-verify.html', baseURL); url.hash = nonce;
      popup = window.open(url.href, '_blank', 'popup,width=460,height=540');
      if (!popup) { description.textContent = 'Allow the verification popup, then select Verify network access again.'; return; }
      description.textContent = 'Complete verification in the separate window. This request will continue when it succeeds.';
    });
    cancel.addEventListener('click', abort); dialog.addEventListener('cancel', event => { event.preventDefault(); abort(); });
    signal?.addEventListener('abort', abort, { once: true });
    dialog.append(title, description, open, cancel); document.body.append(dialog); dialog.showModal();
  });
}
