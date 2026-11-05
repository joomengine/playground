import {
  VERSION, REQUEST_HEADER, RESPONSE_HEADER, RelayError, readPolicy, validateDestination,
  requestHeaders, responseHeaders, encodeMetadata, decodeMetadata, ANONYMOUS_HEADERS, TURNSTILE_TEST_TOKEN,
} from './policy.mjs';

const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();
function errorResponse(error) {
  const known = error instanceof RelayError;
  return Response.json({ version: VERSION, error: {
    code: known ? error.code : 'RELAY_UNAVAILABLE',
    message: known ? error.message : 'The network service could not complete this request.',
  } }, { status: known ? error.status : 503, headers: {
    'Cache-Control': 'no-store', ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}),
  } });
}
function tokenValue(request) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new RelayError('RELAY_SESSION_REQUIRED', 'A valid network session is required.', 401);
  return token;
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function randomToken(randomBytes) {
  return btoa(String.fromCharCode(...randomBytes(32))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function clock() { return Date.now(); }
function randomBytes(size) { return crypto.getRandomValues(new Uint8Array(size)); }
function timeoutError() { return new RelayError('UPSTREAM_TIMEOUT', 'The upstream request exceeded its deadline.', 504); }
function abortedError() { return new RelayError('REQUEST_ABORTED', 'The request was cancelled.', 499); }
function guarded(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || abortedError());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason || abortedError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
async function boundedJSON(request, maximum = 4096, signal = AbortSignal.timeout(10000)) {
  if (!request.body) throw new RelayError('INVALID_METADATA', 'A JSON request body is required.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await guarded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new RelayError('REQUEST_TOO_LARGE', 'The session request exceeds its limit.', 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RelayError('INVALID_METADATA', 'A valid JSON request body is required.'); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
}

/** The public entry point owns CORS. No upstream response header is installed here. */
export function createRelayWorker({ now = clock } = {}) {
  return {
    async fetch(request, env) {
      let policy; let origin;
      try {
        policy = readPolicy(env);
        const url = new URL(request.url);
        if (url.pathname === '/healthz' && request.method === 'GET') {
          return Response.json({ version: VERSION, enabled: policy.enabled, mode: 'controlled-origins' }, { headers: { 'Cache-Control': 'no-store' } });
        }
        origin = request.headers.get('origin');
        if (!origin || !policy.allowedOrigins.has(origin)) throw new RelayError('ORIGIN_NOT_ALLOWED', 'This browser origin is not permitted.', 403);
        if (!policy.enabled) throw new RelayError('RELAY_DISABLED', 'The network service is disabled.', 503);
        if (url.origin !== policy.audience || url.search) throw new RelayError('RELAY_AUDIENCE_MISMATCH', 'The network service address is not permitted.', 403);
        if (!['/v1/session', '/v1/fetch'].includes(url.pathname)) throw new RelayError('NOT_FOUND', 'Unknown network service operation.', 404);
        if (request.method === 'OPTIONS') {
          const requested = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
          if (request.headers.get('access-control-request-method') !== 'POST' || requested.some(name => !['authorization', 'content-type', 'x-playground-request', ...(policy.testMode ? ['x-playground-staging-test'] : [])].includes(name))) throw new RelayError('METHOD_NOT_ALLOWED', 'Unsupported preflight request.', 405);
          return cors(new Response(null, { status: 204 }), origin, policy.testMode);
        }
        if (request.method !== 'POST') throw new RelayError('METHOD_NOT_ALLOWED', 'Use POST for this network operation.', 405);
        if (!env.RELAY_STATE) throw new RelayError('RELAY_UNAVAILABLE', 'The network service state store is unavailable.', 503);
        const headers = new Headers(request.headers);
        // Overwrite any caller-provided internal values. Retries by the platform
        // retain this dispatch identity; the coordinator will never repeat a write.
        headers.set('X-Relay-Dispatch', crypto.randomUUID());
        headers.set('X-Relay-Started', String(now()));
        const forwarded = new Request(request, { headers, signal: request.signal });
        const stub = env.RELAY_STATE.get(env.RELAY_STATE.idFromName('network-v1'));
        return cors(await stub.fetch(forwarded, { signal: request.signal }), origin, policy.testMode);
      } catch (error) {
        const response = errorResponse(error);
        return origin && policy?.allowedOrigins.has(origin) ? cors(response, origin, policy.testMode) : response;
      }
    },
  };
}
function cors(response, origin, testMode = false) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', `Authorization, Content-Type, X-Playground-Request${testMode ? ', X-Playground-Staging-Test' : ''}`);
  headers.set('Access-Control-Expose-Headers', 'X-Playground-Response, Retry-After');
  headers.set('Access-Control-Max-Age', '300');
  headers.set('Vary', 'Origin');
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}
export default createRelayWorker();

/** A single SQLite-backed object supplies exact deployment and session budgets.
 * Storage transactions contain only storage operations, never upstream I/O.
 * This intentionally favors auditable hard limits over unbounded distribution.
 */
export class RelayCoordinator {
  constructor(state, env, { fetcher = globalThis.fetch.bind(globalThis), now = clock, bytes = randomBytes, logger = value => console.log(JSON.stringify(value)) } = {}) {
    this.state = state; this.env = env; this.fetcher = fetcher; this.now = now; this.bytes = bytes; this.logger = logger;
  }
  async fetch(request) {
    try {
      const policy = readPolicy(this.env);
      if (!policy.enabled) throw new RelayError('RELAY_DISABLED', 'The network service is disabled.', 503);
      const url = new URL(request.url);
      if (url.origin !== policy.audience || !policy.allowedOrigins.has(request.headers.get('origin'))) throw new RelayError('ORIGIN_NOT_ALLOWED', 'The session origin is not permitted.', 403);
      if (url.pathname === '/v1/session') return await this.session(request, policy);
      if (url.pathname === '/v1/fetch') return await this.relay(request, policy);
      throw new RelayError('NOT_FOUND', 'Unknown network service operation.', 404);
    } catch (error) {
      if (request.body && !request.body.locked) request.body.cancel(error).catch(() => {});
      return errorResponse(error);
    }
  }
  async transaction(callback) { return this.state.storage.transaction(callback); }
  async sessionRecord(storage, key, request, policy, now = this.now()) {
    const session = await storage.get(key);
    if (!session) throw new RelayError('RELAY_SESSION_REQUIRED', 'The network session is invalid.', 401);
    if (session.expiresAt <= now || session.createdAt + policy.limits.maxSessionMs <= now) throw new RelayError('RELAY_SESSION_EXPIRED', 'The network session has expired.', 401);
    if (session.audience !== policy.audience || session.origin !== request.headers.get('origin') || session.policyVersion !== policy.policyVersion || policy.revoked.has(session.id)) throw new RelayError('RELAY_SESSION_REVOKED', 'The network session is no longer permitted.', 401);
    return session;
  }
  async session(request, policy) {
    const sessionSignal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.min(policy.limits.headerMs, 10000))]);
    const now = this.now();
    if (policy.testMode) {
      const credential = request.headers.get('X-Playground-Staging-Test');
      if (!credential || credential.length > 256 || await digest(credential) !== await digest(this.env.STAGING_TEST_SECRET)) {
        throw new RelayError('STAGING_TEST_AUTH_REQUIRED', 'The isolated staging test requires its CI credential.', 403);
      }
    }
    let renewal; let ip;
    if (request.headers.has('authorization')) {
      const token = tokenValue(request); const key = `session:${await digest(token)}`;
      // Authenticate and reserve the renewal interval before reading a possibly
      // unfinished body. Failed renewal attempts must not bypass admission.
      await this.transaction(async storage => {
        const session = await this.sessionRecord(storage, key, request, policy, now);
        const previousAttempt = session.renewalAttemptAt ?? session.renewedAt;
        if (now - previousAttempt < policy.limits.renewalMs) throw new RelayError('RATE_LIMITED', 'Please wait before renewing this network session.', 429, Math.ceil((policy.limits.renewalMs - (now - previousAttempt)) / 1000));
        session.renewalAttemptAt = now;
        await storage.put(key, session);
      });
      renewal = { token, key };
    } else {
      ip = request.headers.get('CF-Connecting-IP');
      if (!ip) throw new RelayError('RELAY_UNAVAILABLE', 'The network service could not identify this request.', 503);
      const hour = Math.floor(now / 3600000);
      const issuanceKey = `issuance:${hour}:${await digest(ip)}`;
      const globalKey = `issuance:${hour}:global`;
      // Count every admitted creation attempt before JSON reads, including
      // malformed, oversized or stalled bodies and unsuccessful verification.
      await this.transaction(async storage => {
        const local = await storage.get(issuanceKey) || { count: 0, cleanupAt: (hour + 2) * 3600000 };
        const global = await storage.get(globalKey) || { count: 0, cleanupAt: (hour + 2) * 3600000 };
        if (local.count >= policy.limits.issuancePerHour || global.count >= policy.limits.issuanceGlobalPerHour) throw new RelayError('RATE_LIMITED', 'Network session creation is temporarily limited.', 429, Math.ceil(((hour + 1) * 3600000 - now) / 1000));
        local.count++; global.count++;
        await storage.put({ [issuanceKey]: local, [globalKey]: global });
      });
      await this.scheduleCleanup(now);
    }
    const payload = await boundedJSON(request, 4096, sessionSignal);
    if (payload?.version !== VERSION) throw new RelayError('UNSUPPORTED_PROTOCOL_VERSION', 'Unsupported relay protocol version.');
    if (renewal) {
      const expiresAt = await this.transaction(async storage => {
        const session = await this.sessionRecord(storage, renewal.key, request, policy);
        session.expiresAt = Math.min(this.now() + policy.limits.sessionMs, session.createdAt + policy.limits.maxSessionMs);
        session.renewedAt = this.now();
        await storage.put(renewal.key, session);
        return session.expiresAt;
      });
      return Response.json({ version: VERSION, token: renewal.token, expiresAt });
    }
    if (typeof payload.turnstileToken !== 'string' || !payload.turnstileToken || payload.turnstileToken.length > 2048) throw new RelayError('VERIFICATION_REQUIRED', 'Browser verification is required.', 401);
    if (policy.testMode && payload.turnstileToken !== TURNSTILE_TEST_TOKEN) throw new RelayError('VERIFICATION_FAILED', 'The isolated staging test requires the official dummy token.', 401);
    const verification = await guarded(this.fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: this.env.TURNSTILE_SECRET_KEY, response: payload.turnstileToken, remoteip: ip }),
      signal: sessionSignal, redirect: 'manual',
    }), sessionSignal);
    let result; try { result = await boundedJSON(verification, 8192, sessionSignal); } catch { throw new RelayError('VERIFICATION_FAILED', 'Browser verification failed.', 401); }
    const origin = request.headers.get('origin');
    const verifiedScope = policy.testMode
      ? result.metadata?.result_with_testing_key === true
      : result.hostname === new URL(origin).hostname && result.action === policy.action;
    if (!verification.ok || result.success !== true || !verifiedScope) throw new RelayError('VERIFICATION_FAILED', 'Browser verification failed.', 401);
    const token = randomToken(this.bytes); const id = crypto.randomUUID();
    const expiresAt = now + policy.limits.sessionMs;
    await this.state.storage.put(`session:${await digest(token)}`, {
      id, origin, audience: policy.audience, policyVersion: policy.policyVersion,
      methods: policy.methods, destinations: [...policy.upstreamOrigins], credentials: [...policy.credentialOrigins],
      createdAt: now, expiresAt, renewedAt: now, cleanupAt: now + policy.limits.maxSessionMs,
      bytes: 0, minute: 0, requests: 0, active: {}, dispatches: {},
    });
    await this.scheduleCleanup(now);
    return Response.json({ version: VERSION, token, expiresAt, sessionId: id });
  }
  async reserve(key, request, policy, metadata, dispatchId, started) {
    const now = this.now(); const minute = Math.floor(now / 60000); const day = Math.floor(now / 86400000);
    const globalKey = `usage:${day}`;
    return this.transaction(async storage => {
      const session = await this.sessionRecord(storage, key, request, policy, now);
      if (!session.methods.includes(metadata.method) || !session.destinations.includes(new URL(metadata.url).origin)) throw new RelayError('DESTINATION_NOT_ALLOWED', 'The network session does not permit this request.', 403);
      if (metadata.forwardCredentials && !session.credentials.includes(new URL(metadata.url).origin)) throw new RelayError('CREDENTIALS_NOT_ALLOWED', 'This session does not permit credential forwarding.', 403);
      session.active = Object.fromEntries(Object.entries(session.active).filter(([, expiry]) => expiry > now));
      session.dispatches = Object.fromEntries(Object.entries(session.dispatches).filter(([, expiry]) => expiry > now));
      if (session.dispatches[dispatchId]) throw new RelayError('REQUEST_ALREADY_DISPATCHED', 'This request was already dispatched; it will not be repeated.', 409);
      if (Object.keys(session.active).length >= policy.limits.concurrent) throw new RelayError('RATE_LIMITED', 'The network session has too many active requests.', 429, 1);
      if (session.minute !== minute) { session.minute = minute; session.requests = 0; }
      const global = await storage.get(globalKey) || { requests: 0, bytes: 0, cleanupAt: (day + 2) * 86400000 };
      if (session.requests >= policy.limits.requestsPerMinute || session.bytes >= policy.limits.sessionBytes || global.requests >= policy.limits.globalRequestsPerDay || global.bytes >= policy.limits.globalBytesPerDay) throw new RelayError('RATE_LIMITED', 'The network request or byte quota has been reached.', 429, 60);
      session.requests++; global.requests++;
      session.active[dispatchId] = started + policy.limits.totalMs;
      session.dispatches[dispatchId] = started + policy.limits.totalMs;
      await storage.put({ [key]: session, [globalKey]: global });
      return { globalKey, sessionId: session.id, methods: session.methods, destinations: session.destinations };
    });
  }
  async charge(key, globalKey, count, policy) {
    const exceeded = await this.transaction(async storage => {
      const session = await storage.get(key); const global = await storage.get(globalKey);
      if (!session || !global) return true;
      const denied = session.bytes + count > policy.limits.sessionBytes || global.bytes + count > policy.limits.globalBytesPerDay;
      // Charge received bytes even when the chunk crosses a boundary. Saturating
      // counters prevent repeated over-budget transfers from contacting upstream.
      session.bytes = Math.min(policy.limits.sessionBytes, session.bytes + count);
      global.bytes = Math.min(policy.limits.globalBytesPerDay, global.bytes + count);
      await storage.put({ [key]: session, [globalKey]: global });
      return denied;
    });
    if (exceeded) throw new RelayError('RATE_LIMITED', 'The network byte quota has been reached.', 429, 60);
  }
  async release(key, dispatchId) {
    await this.transaction(async storage => {
      const session = await storage.get(key);
      if (session?.active?.[dispatchId]) { delete session.active[dispatchId]; await storage.put(key, session); }
    });
  }
  async relay(request, policy) {
    const token = tokenValue(request); const key = `session:${await digest(token)}`;
    const metadata = decodeMetadata(request.headers.get(REQUEST_HEADER));
    if (!policy.methods.includes(metadata.method) || !['follow', 'manual', 'error'].includes(metadata.redirect)
      || !Number.isInteger(metadata.maxRedirects) || metadata.maxRedirects < 0 || metadata.maxRedirects > policy.limits.redirects
      || !Number.isFinite(metadata.timeoutMs) || metadata.timeoutMs <= 0
      || (metadata.forwardCredentials !== undefined && typeof metadata.forwardCredentials !== 'boolean')) throw new RelayError('INVALID_METADATA', 'Unsupported request method, redirect policy or deadline.');
    let url = validateDestination(metadata.url, policy, new URL(request.url).origin);
    const headers = requestHeaders(metadata, policy, url);
    const dispatchId = request.headers.get('X-Relay-Dispatch'); const started = Number(request.headers.get('X-Relay-Started'));
    if (!/^[a-f\d-]{36}$/.test(dispatchId || '') || !Number.isFinite(started) || started > this.now() || this.now() - started >= policy.limits.totalMs) throw timeoutError();
    const reservation = await this.reserve(key, request, policy, metadata, dispatchId, started);
    const controller = new AbortController();
    const abort = () => controller.abort(abortedError());
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const total = Math.min(metadata.timeoutMs, policy.limits.totalMs - (this.now() - started));
    const timer = setTimeout(() => controller.abort(timeoutError()), total);
    let finished = false; let bytes = 0; let status = 0;
    const finish = async error => {
      if (finished) return; finished = true;
      clearTimeout(timer); request.signal.removeEventListener('abort', abort);
      await this.release(key, dispatchId);
      this.logger({ requestId: dispatchId, route: 'relay', method: metadata.method, hostname: url.hostname,
        durationMs: this.now() - started, bytes, status, error: error?.code || (error ? 'RESPONSE_INCOMPLETE' : null) });
    };
    try {
      if (request.body && ['GET', 'HEAD'].includes(metadata.method)) {
        // workerd may represent an empty POST envelope as an empty stream.
        // Authentication and request accounting have already completed.
        const reader = request.body.getReader();
        try {
          for (;;) {
            const first = await guarded(reader.read(), controller.signal);
            if (first.done) break;
            if (first.value.byteLength) throw new RelayError('INVALID_METADATA', 'GET and HEAD requests cannot contain an upload body.');
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      const contentLength = request.headers.get('Content-Length');
      if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > policy.limits.uploadBytes)) throw new RelayError('REQUEST_TOO_LARGE', 'The upload exceeds the network service limit.', 413);
      let uploadBytes = 0;
      const upload = request.body && !['GET', 'HEAD'].includes(metadata.method) ? this.limitedUpload(request.body, controller, policy, count => { uploadBytes += count; return uploadBytes; }) : null;
      let method = metadata.method; let body = upload; let redirected = false; let redirectCount = 0;
      let upstream;
      for (let hops = 0;; hops++) {
        const headerTimer = setTimeout(() => controller.abort(timeoutError()), Math.min(total, policy.limits.headerMs));
        try {
          upstream = await guarded(this.fetcher(url.href, {
            method, headers, body, signal: controller.signal, redirect: 'manual',
            credentials: 'omit', ...(body ? { duplex: 'half' } : {}),
            cf: { cacheTtl: 0, cacheEverything: false },
          }), controller.signal);
        } finally { clearTimeout(headerTimer); }
        status = upstream.status;
        if (![301, 302, 303, 307, 308].includes(status) || !upstream.headers.has('location') || metadata.redirect === 'manual') break;
        if (metadata.redirect === 'error') { await upstream.body?.cancel(); throw new RelayError('UPSTREAM_REDIRECT', 'The upstream returned a redirect that the caller forbids.', 502); }
        if (hops >= metadata.maxRedirects) { await upstream.body?.cancel(); throw new RelayError('TOO_MANY_REDIRECTS', 'The upstream exceeded the redirect limit.', 502); }
        const location = new URL(upstream.headers.get('location'), url).href;
        await upstream.body?.cancel();
        const next = validateDestination(location, policy, new URL(request.url).origin);
        const nextMethod = (status === 303 && method !== 'HEAD') || ([301, 302].includes(status) && method === 'POST') ? 'GET' : method;
        if (!reservation.destinations.includes(next.origin)) throw new RelayError('DESTINATION_NOT_ALLOWED', 'The redirect destination is outside this network session scope.', 403);
        if (!policy.methods.includes(nextMethod) || !reservation.methods.includes(nextMethod)) throw new RelayError('METHOD_NOT_ALLOWED', 'The redirect method is outside this network session scope.', 403);
        if (next.origin !== url.origin) {
          for (const name of [...headers.keys()]) if (!ANONYMOUS_HEADERS.has(name)) headers.delete(name);
        }
        if ((status === 303 && method !== 'HEAD') || ([301, 302].includes(status) && method === 'POST')) {
          method = 'GET'; body = null; for (const name of ['content-type', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
        } else if (body) throw new RelayError('UNSUPPORTED_TRANSPORT_OPTION', 'A streamed upload cannot be replayed through an upstream redirect.', 422);
        url = next; redirected = true; redirectCount++;
      }
      const hasBody = method !== 'HEAD' && ![204, 205, 304].includes(status) && upstream.body !== null;
      const encoding = (upstream.headers.get('content-encoding') || '').toLowerCase();
      if (hasBody && !['', 'identity', 'gzip', 'br', 'deflate'].includes(encoding)) {
        await upstream.body.cancel();
        throw new RelayError('UNSUPPORTED_TRANSPORT_OPTION', 'The upstream response uses an unsupported content encoding.', 422);
      }
      // workerd's HTTP fetch decodes gzip/br before JavaScript reads. Its deflate
      // stream remains encoded; decode that supported format explicitly.
      const decoded = hasBody && !!encoding && encoding !== 'identity';
      const expected = !decoded && hasBody && /^\d+$/.test(upstream.headers.get('content-length') || '') ? Number(upstream.headers.get('content-length')) : null;
      if (expected !== null && expected > policy.limits.responseBytes) { await upstream.body?.cancel(); throw new RelayError('RESPONSE_TOO_LARGE', 'The upstream response exceeds the network service limit.', 413); }
      const responseMetadata = encodeMetadata({ version: VERSION, status, statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers, decoded), url: url.href, redirected, redirectCount });
      if (!hasBody) {
        await upstream.body?.cancel(); await finish();
        return new Response(null, { headers: { [RESPONSE_HEADER]: responseMetadata } });
      }
      const decodedBody = encoding === 'deflate' ? upstream.body.pipeThrough(new DecompressionStream('deflate')) : upstream.body;
      const reader = decodedBody.getReader(); const owner = this;
      let idleTimer; let streamController;
      const terminate = () => {
        clearTimeout(idleTimer);
        reader.cancel(controller.signal.reason).catch(() => {});
        streamController?.error(controller.signal.reason || abortedError());
        finish(controller.signal.reason).catch(() => {});
      };
      controller.signal.addEventListener('abort', terminate, { once: true });
      const output = new ReadableStream({
        start(target) { streamController = target; },
        async pull(target) {
          idleTimer = setTimeout(() => controller.abort(timeoutError()), policy.limits.idleMs);
          try {
            const result = await guarded(reader.read(), controller.signal);
            clearTimeout(idleTimer);
            if (result.done) {
              if (expected !== null && bytes !== expected) throw new RelayError('RESPONSE_INCOMPLETE', 'The upstream response ended before all bytes arrived.', 502);
              controller.signal.removeEventListener('abort', terminate);
              await finish(); target.close(); return;
            }
            bytes += result.value.byteLength;
            await owner.charge(key, reservation.globalKey, result.value.byteLength, policy);
            if (bytes > policy.limits.responseBytes) throw new RelayError('RESPONSE_TOO_LARGE', 'The upstream response exceeds the network service limit.', 413);
            target.enqueue(result.value);
          } catch (error) {
            clearTimeout(idleTimer); controller.signal.removeEventListener('abort', terminate);
            controller.abort(error); await reader.cancel(error).catch(() => {}); await finish(error);
            target.error(error);
          }
        },
        async cancel(reason) {
          clearTimeout(idleTimer); controller.signal.removeEventListener('abort', terminate);
          controller.abort(abortedError()); await reader.cancel(reason).catch(() => {}); await finish(abortedError());
        },
      });
      return new Response(output, { headers: { [RESPONSE_HEADER]: responseMetadata, 'Content-Type': 'application/octet-stream' } });
    } catch (error) {
      controller.abort(error); await finish(error);
      if (error instanceof RelayError) throw error;
      if (controller.signal.reason instanceof RelayError) throw controller.signal.reason;
      throw new RelayError('UPSTREAM_NETWORK_FAILED', 'The upstream connection could not be completed.', 502);
    }
  }
  limitedUpload(body, controller, policy, countBytes) {
    const reader = body.getReader();
    return new ReadableStream({
      async pull(target) {
        try {
          const result = await guarded(reader.read(), controller.signal);
          if (result.done) { target.close(); return; }
          if (countBytes(result.value.byteLength) > policy.limits.uploadBytes) throw new RelayError('REQUEST_TOO_LARGE', 'The upload exceeds the network service limit.', 413);
          target.enqueue(result.value);
        } catch (error) { controller.abort(error); await reader.cancel(error).catch(() => {}); target.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    });
  }
  async scheduleCleanup(now) {
    const current = await this.state.storage.getAlarm?.();
    if (!current || current > now + 3600000) await this.state.storage.setAlarm(now + 3600000);
  }
  async alarm() {
    const now = this.now();
    let cursor = await this.state.storage.get('cleanup-cursor') || '';
    let more = true;
    for (let page = 0; page < 10 && more; page++) {
      const entries = await this.state.storage.list({ limit: 1000, ...(cursor ? { startAfter: cursor } : {}) });
      const expired = [...entries].filter(([, value]) => value?.cleanupAt <= now).map(([key]) => key);
      for (let offset = 0; offset < expired.length; offset += 128) await this.state.storage.delete(expired.slice(offset, offset + 128));
      more = entries.size === 1000;
      cursor = more ? [...entries.keys()].at(-1) : '';
    }
    await this.state.storage.put('cleanup-cursor', cursor);
    await this.state.storage.setAlarm(now + (more ? 60000 : 3600000));
  }
}
