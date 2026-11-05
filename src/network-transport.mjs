import { normalizeNetworkConfig } from './network-config.mjs';
import {
  NETWORK_PROTOCOL_VERSION, NETWORK_REQUEST_HEADER, NETWORK_RESPONSE_HEADER,
  MAX_NETWORK_METADATA_BYTES, NetworkError, encodeNetworkMetadata, decodeNetworkMetadata,
} from './network-protocol.mjs';

// Unknown headers may contain credentials (including custom API keys). Their relay
// delivery requires the same explicit trust grant as Authorization and Cookie.
const anonymousHeaders = new Set([
  'accept', 'accept-language', 'accept-encoding', 'cache-control', 'content-type',
  'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range',
  'range', 'user-agent', 'pragma',
]);
const noBodyStatuses = new Set([204, 205, 304]);
const safeMethods = new Set(['GET', 'HEAD']);
// Symbolic error codes are extensible within protocol v1, but arbitrary remote
// messages never enter diagnostics or PHP errors.
const relayErrorCode = /^[A-Z][A-Z0-9_]{2,63}$/;

function abortFailure(signal, timedOut) {
  timedOut ||= signal.reason?.name === 'TimeoutError' || signal.reason?.code === 'UPSTREAM_TIMEOUT';
  return new NetworkError(timedOut ? 'UPSTREAM_TIMEOUT' : 'REQUEST_ABORTED',
    timedOut ? 'The HTTP request exceeded its deadline.' : 'The HTTP request was cancelled.', { cause: signal.reason });
}

function context(signal, deadline, now) {
  const controller = new AbortController();
  let timedOut = false, timer;
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  if (Number.isFinite(deadline)) {
    const expire = () => { timedOut = true; controller.abort(new DOMException('HTTP request deadline exceeded.', 'TimeoutError')); };
    if (deadline <= now()) expire();
    else timer = setTimeout(expire, Math.min(deadline - now(), 2147483647));
  }
  return {
    signal: controller.signal,
    check() { if (controller.signal.aborted) throw abortFailure(controller.signal, timedOut); },
    failure() { return controller.signal.aborted ? abortFailure(controller.signal, timedOut) : null; },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); },
    stop(reason) { controller.abort(reason); },
  };
}

// Race injectable/session work as well as native Fetch: abort cannot depend on a
// third-party session callback remembering to listen for cancellation itself.
async function cancellable(operation, ctx) {
  ctx.check();
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        onAbort = () => reject(ctx.failure());
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        if (ctx.signal.aborted) onAbort();
      }),
    ]);
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

function describe(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const originalURL = request?.url ?? String(input);
  const url = new URL(originalURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new NetworkError('UNSUPPORTED_TRANSPORT_OPTION', 'Only HTTP(S) URLs without embedded credentials are supported.');
  }
  const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers ?? request?.headers);
  const signal = init.signal ?? request?.signal;
  const redirect = init.network?.redirect ?? init.redirect ?? request?.redirect ?? 'follow';
  if (!['follow', 'manual', 'error'].includes(redirect)) throw new NetworkError('UNSUPPORTED_TRANSPORT_OPTION', 'Unsupported redirect mode.');
  const body = init.body ?? request?.body ?? null;
  const forwardCredentials = [...headers.keys()].some(name => !anonymousHeaders.has(name));
  const replayAllowed = safeMethods.has(method) && body === null && !forwardCredentials
    && (init.credentials ?? request?.credentials) !== 'include' && init.network?.replayAllowed !== false;
  return { originalURL, url, method, headers, signal, redirect, body, forwardCredentials, replayAllowed };
}

function responseMetadata(raw) {
  const value = decodeNetworkMetadata(raw);
  if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599
    || typeof value.statusText !== 'string' || /[^\x20-\x7e]/.test(value.statusText)
    || typeof value.url !== 'string' || typeof value.redirected !== 'boolean'
    || (value.redirectCount !== undefined && (!Number.isInteger(value.redirectCount) || value.redirectCount < 0 || value.redirectCount > 20))
    || !Array.isArray(value.headers) || value.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== 'string'))) {
    throw new NetworkError('RELAY_PROTOCOL_ERROR', 'The network service returned malformed response metadata.');
  }
  try {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid effective URL.');
    value.headers = new Headers(value.headers);
  } catch (cause) {
    throw new NetworkError('RELAY_PROTOCOL_ERROR', 'The network service returned invalid HTTP metadata.', { cause });
  }
  return value;
}

async function relayFailure(response, ctx) {
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  try {
    if (reader) while (true) {
      const item = await cancellable(() => reader.read(), ctx);
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_NETWORK_METADATA_BYTES) throw new Error('Oversized relay error.');
      chunks.push(item.value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
    if (value?.version !== NETWORK_PROTOCOL_VERSION || !relayErrorCode.test(value?.error?.code || '')) throw new Error('Invalid relay error.');
    // The code, status and Retry-After are safe to expose. Never echo remote
    // bodies/messages that may contain target query strings or credentials.
    return new NetworkError(value.error.code, `The network service rejected the request (${value.error.code}).`, {
      status: response.status, retryAfter: response.headers.get('Retry-After') ?? undefined,
    });
  } catch (cause) {
    void reader?.cancel().catch(() => {});
    return ctx.failure() ?? new NetworkError('RELAY_PROTOCOL_ERROR', 'The network service returned an invalid error response.', { status: response.status, cause });
  } finally { reader?.releaseLock(); }
}

function wrapResponse(response, ctx, metadata, method, report) {
  const status = metadata?.status ?? response.status;
  const headers = metadata?.headers ?? response.headers;
  const reader = response.body?.getReader();
  const empty = method === 'HEAD' || noBodyStatuses.has(status) || !reader;
  let done = false, bytes = 0;
  const finish = error => { if (!done) { done = true; ctx.close(); report?.(bytes, error); } };
  const body = empty ? null : new ReadableStream({
    async pull(controller) {
      try {
        const item = await cancellable(() => reader.read(), ctx);
        if (item.done) { finish(); controller.close(); reader.releaseLock(); }
        else { bytes += item.value.byteLength; controller.enqueue(item.value); }
      } catch (cause) {
        const error = ctx.failure() ?? new NetworkError('RESPONSE_INCOMPLETE', 'The HTTP response ended before delivery completed.', { cause });
        finish(error);
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      ctx.stop(reason); finish(ctx.failure());
      await reader.cancel(reason).catch(() => {});
    },
  });
  if (empty) { void reader?.cancel().catch(() => {}); finish(); }
  const result = new Response(body, { status, statusText: metadata?.statusText ?? response.statusText, headers });
  // The cURL bridge consumes status/headers/body and Response.url. Native Fetch
  // gives these getters read-only values, so preserve effective metadata here.
  Object.defineProperties(result, {
    url: { value: metadata?.url ?? response.url },
    redirected: { value: metadata?.redirected ?? response.redirected },
    // Native cURL knows how to handle hidden CORS compression headers. Relay
    // metadata already describes the bytes delivered by its explicit envelope.
    type: { value: metadata ? 'basic' : response.type },
    networkRedirectCount: { value: metadata ? metadata.redirectCount ?? (metadata.redirected ? undefined : 0) : undefined },
  });
  return result;
}

/** Shared component-neutral routing; only call this from the PHP HTTP bridge. */
export function createNetworkTransport(fetcher, rawConfig = {}, {
  getSession, onDiagnostic, now = Date.now, allowInsecureLocalhost = false,
} = {}) {
  const config = normalizeNetworkConfig(rawConfig, { allowInsecureLocalhost });
  return async (input, init = {}) => {
    const request = describe(input, init);
    const started = now();
    const timeout = init.network?.timeoutMs;
    const explicitDeadline = init.network?.deadline;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) throw new NetworkError('UNSUPPORTED_TRANSPORT_OPTION', 'Invalid HTTP timeout.');
    if (explicitDeadline !== undefined && (!Number.isFinite(explicitDeadline) || explicitDeadline < 0)) throw new NetworkError('UNSUPPORTED_TRANSPORT_OPTION', 'Invalid HTTP deadline.');
    const deadline = Math.min(timeout > 0 ? started + timeout : Infinity, explicitDeadline ?? Infinity);
    const ctx = context(request.signal, deadline, now);
    const requestId = crypto.randomUUID();
    let route = config.enabled && (request.url.protocol === 'http:' || config.proxyOrigins.includes(request.url.origin)) ? 'relay' : 'direct';
    const diagnostic = (status, code, bytes) => {
      try { onDiagnostic?.({ requestId, route, method: request.method, hostname: request.url.hostname, durationMs: now() - started, status, code, bytes }); } catch { /* Logging must not alter transport outcomes. */ }
    };
    try {
      ctx.check();
      if (route === 'direct') {
        const { network: _network, ...directInit } = init;
        try {
          const response = await cancellable(() => fetcher(input, {
            ...directInit, signal: ctx.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
            // Fetch only strips standard authentication on cross-origin redirects;
            // custom API-key headers would otherwise follow to the new origin.
            // Without a preselected trusted relay, fail a credentialed redirect
            // before forwarding it. Manual requests remain manual for PHP.
            ...(request.forwardCredentials ? { redirect: request.redirect === 'manual' ? 'manual' : 'error' } : {}),
          }), ctx);
          ctx.check();
          if (response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
            void response.body?.cancel().catch(() => {});
            throw new NetworkError('DIRECT_NETWORK_FAILED', 'The browser did not expose the HTTP response.');
          }
          return wrapResponse(response, ctx, null, request.method, (bytes, error) => diagnostic(response.status, error?.code, bytes));
        } catch (cause) {
          ctx.check();
          if (!config.enabled || !request.replayAllowed) throw new NetworkError('DIRECT_NETWORK_FAILED', 'The browser could not complete the HTTP request.', { cause });
          route = 'relay';
        }
      }
      if (request.forwardCredentials && !config.credentialGrants.some(grant =>
        grant.relayOrigin === new URL(config.endpoint).origin && grant.destinationOrigin === request.url.origin)) {
        throw new NetworkError('CREDENTIAL_FORWARDING_DENIED', 'Forwarding credentials requires a grant for this relay and destination.');
      }
      if (typeof getSession !== 'function') throw new NetworkError('RELAY_SESSION_REQUIRED', 'Verification is required to use the network service.');
      const session = await cancellable(() => getSession({ signal: ctx.signal, deadline }), ctx);
      ctx.check();
      if (!session || typeof session.token !== 'string' || !session.token || /[\r\n]/.test(session.token)
        || !Number.isFinite(session.expiresAt) || session.expiresAt <= now()) {
        throw new NetworkError('RELAY_SESSION_EXPIRED', 'The network session has expired.');
      }
      const requestedRedirects = init.network?.maxRedirects ?? config.maxRedirects;
      if (!Number.isInteger(requestedRedirects) || requestedRedirects < -1) throw new NetworkError('UNSUPPORTED_TRANSPORT_OPTION', 'Invalid HTTP redirect limit.');
      // The relay's independent policy ceiling also applies when PHP requests
      // unlimited redirects (-1). It does not change a direct PHP request.
      const maxRedirects = requestedRedirects === -1 ? config.maxRedirects : Math.min(requestedRedirects, config.maxRedirects);
      // Keep existing binary/string/Blob bodies raw. FormData requires its exact
      // generated boundary in upstream metadata. Buffer only bounded uploads
      // which otherwise require browser request-streaming support (not portable
      // across WebKit or HTTP/1). Downloaded ZIPs always remain streamed.
      let body = request.body;
      const upstreamHeaders = new Headers(request.headers);
      if (body != null) {
        const serialized = new Request(request.originalURL, { method: request.method, headers: upstreamHeaders, body,
          ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
        for (const [key, value] of serialized.headers) upstreamHeaders.set(key, value);
        if (body instanceof ReadableStream || body instanceof FormData) {
          const reader = serialized.body.getReader();
          const chunks = []; let length = 0;
          try {
            while (true) {
              const item = await cancellable(() => reader.read(), ctx);
              if (item.done) break;
              length += item.value.byteLength;
              if (length > 8 * 1024 * 1024) throw new NetworkError('REQUEST_TOO_LARGE', 'The upload exceeds the relay body limit.');
              chunks.push(item.value);
            }
            body = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
          } catch (error) { void reader.cancel(error).catch(() => {}); throw error; }
          finally { reader.releaseLock(); }
        }
      }
      const metadata = {
        version: NETWORK_PROTOCOL_VERSION, url: request.originalURL, method: request.method,
        headers: [...upstreamHeaders], redirect: request.redirect, maxRedirects,
        timeoutMs: Number.isFinite(deadline) ? Math.max(1, Math.ceil(deadline - now())) : 120000,
        forwardCredentials: request.forwardCredentials,
      };
      const relayInit = {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, [NETWORK_REQUEST_HEADER]: encodeNetworkMetadata(metadata) },
        body, signal: ctx.signal, credentials: 'omit', mode: 'cors', cache: 'no-store',
        redirect: 'error', referrerPolicy: 'no-referrer',
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      };
      let response;
      try { response = await cancellable(() => fetcher(`${config.endpoint}/v1/fetch`, relayInit), ctx); }
      catch (cause) { throw ctx.failure() ?? new NetworkError('RELAY_UNAVAILABLE', 'The network service could not be reached.', { cause }); }
      ctx.check();
      if (response.status !== 200) throw await relayFailure(response, ctx);
      let metadataResponse;
      try { metadataResponse = responseMetadata(response.headers.get(NETWORK_RESPONSE_HEADER)); }
      catch (error) { void response.body?.cancel(error).catch(() => {}); throw error; }
      return wrapResponse(response, ctx, metadataResponse, request.method, (bytes, error) => diagnostic(metadataResponse.status, error?.code, bytes));
    } catch (error) {
      ctx.close();
      diagnostic(error.status, error.code ?? 'DIRECT_NETWORK_FAILED');
      throw error;
    }
  };
}
