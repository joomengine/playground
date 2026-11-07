import { normalizeNetworkConfig, loadNetworkConfiguration } from './network-config.mjs';
import {
  NETWORK_PROTOCOL_VERSION, NETWORK_REQUEST_HEADER, NETWORK_RESPONSE_HEADER,
  NetworkError, encodeNetworkMetadata, decodeNetworkMetadata,
} from './network-protocol.mjs';

const noBodyStatuses = new Set([204, 205, 304]);
const readMethods = new Set(['GET', 'HEAD']);

function requestContext(signal, deadline, now) {
  const controller = new AbortController();
  let timer;
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  if (Number.isFinite(deadline)) {
    const expire = () => controller.abort(new DOMException('HTTP request deadline exceeded.', 'TimeoutError'));
    if (deadline <= now()) expire();
    else timer = setTimeout(expire, Math.min(deadline - now(), 2147483647));
  }
  return {
    signal: controller.signal,
    check() { if (controller.signal.aborted) throw this.failure(); },
    failure() {
      const timeout = controller.signal.reason?.name === 'TimeoutError';
      return new NetworkError(timeout ? 'UPSTREAM_TIMEOUT' : 'REQUEST_ABORTED',
        timeout ? 'The HTTP request exceeded its deadline.' : 'The HTTP request was cancelled.', { cause: controller.signal.reason });
    },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); },
    stop(reason) { controller.abort(reason); },
  };
}

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
  } finally { ctx.signal.removeEventListener('abort', onAbort); }
}

function wrapResponse(response, ctx, metadata, method, proxied = false) {
  const status = metadata?.status ?? response.status;
  const reader = response.body?.getReader();
  const empty = method === 'HEAD' || noBodyStatuses.has(status) || !reader;
  const body = empty ? null : new ReadableStream({
    async pull(controller) {
      try {
        const item = await cancellable(() => reader.read(), ctx);
        if (item.done) { ctx.close(); reader.releaseLock(); controller.close(); }
        else controller.enqueue(item.value);
      } catch (cause) {
        const error = ctx.signal.aborted ? ctx.failure() : new NetworkError('RESPONSE_INCOMPLETE', 'The HTTP response could not be read completely.', { cause });
        ctx.close(); void reader.cancel(error).catch(() => {}); controller.error(error);
      }
    },
    async cancel(reason) { ctx.stop(reason); ctx.close(); await reader.cancel(reason).catch(() => {}); },
  });
  if (empty) { void reader?.cancel().catch(() => {}); ctx.close(); }
  const result = new Response(body, {
    status, statusText: metadata?.statusText ?? response.statusText,
    headers: metadata?.headers ?? response.headers,
  });
  Object.defineProperties(result, {
    url: { value: metadata?.url ?? response.url },
    redirected: { value: metadata?.redirected ?? response.redirected },
    type: { value: proxied ? 'basic' : response.type },
    networkRedirectCount: { value: metadata?.redirectCount },
  });
  return result;
}

/** Direct Fetch for reads, with anonymous proxy fallback when the browser cannot expose a response. */
export function createNetworkTransport(fetcher = globalThis.fetch.bind(globalThis), rawConfig = {}, {
  now = Date.now, contextOrigin = globalThis.location?.origin,
} = {}) {
  const configured = typeof rawConfig === 'function' ? null : normalizeNetworkConfig(rawConfig);
  return async (input, init = {}) => {
    const original = input instanceof Request ? input : null;
    const target = new URL(original?.url ?? String(input), globalThis.location?.href);
    const method = String(init.method ?? original?.method ?? 'GET').toUpperCase();
    const body = init.body ?? null;
    const network = init.network ?? {};
    const redirect = network.redirect ?? init.redirect ?? original?.redirect ?? 'follow';
    const timeout = network.timeoutMs;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) throw new TypeError('Invalid HTTP timeout.');
    const deadline = Math.min(timeout > 0 ? now() + timeout : Infinity, network.deadline ?? Infinity);
    const ctx = requestContext(init.signal ?? original?.signal, deadline, now);
    const { network: _network, ...fetchInit } = init;
    const directInit = { ...fetchInit, redirect: init.redirect ?? original?.redirect ?? redirect, signal: ctx.signal,
      ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}) };
    let endpoint = configured?.endpoint;
    let resolved = configured !== null;
    const resolveEndpoint = async () => {
      if (!resolved) {
        endpoint = normalizeNetworkConfig(await cancellable(rawConfig, ctx)).endpoint;
        resolved = true;
      }
      return endpoint;
    };
    try {
      ctx.check();
      // These explicit headers cannot be delivered unchanged by browser Fetch.
      // Send them through the proxy once; ordinary read headers stay direct.
      const headers = new Headers(init.headers ?? original?.headers);
      const browserHeaderDelivery = /^https?:$/.test(globalThis.location?.protocol)
        && ['cookie', 'origin', 'referer'].some(name => headers.has(name));
      // An uncertain write cannot be retried, so choose its route up front.
      const proxyFirst = (browserHeaderDelivery || !readMethods.has(method) && target.origin !== contextOrigin)
        && await resolveEndpoint();
      if (!proxyFirst) {
        let response;
        try {
          response = await cancellable(() => fetcher(original ?? target.href, directInit), ctx);
          ctx.check();
          if (response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
            void response.body?.cancel().catch(() => {});
            throw new TypeError('The browser did not expose the HTTP response.');
          }
        } catch (cause) {
          ctx.check();
          if (!readMethods.has(method) || !await resolveEndpoint()) throw new NetworkError('DIRECT_NETWORK_FAILED', 'The HTTP request could not be completed.', { cause });
          response = undefined;
        }
        if (response) return wrapResponse(response, ctx, null, method);
      }

      const proxyURL = new URL(endpoint);
      proxyURL.searchParams.set('url', target.href);
      let proxyBody = body;
      const upstreamHeaders = new Headers(init.headers ?? original?.headers);
      if (body != null || original) {
        const serialized = new Request(original ?? target, { method, headers: upstreamHeaders,
          ...(body != null ? { body } : {}),
          ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
        for (const [key, value] of serialized.headers) upstreamHeaders.set(key, value);
        // Browser Fetch cannot upload streams in every supported engine or
        // over HTTP/1. Serialize once, preserving the generated multipart
        // boundary; downloaded responses continue to stream without buffering.
        if (!readMethods.has(method) && (original || body instanceof ReadableStream || body instanceof FormData)) {
          // Firefox versions without Request.body still retain the payload in
          // the Request's Body methods. An absent stream does not mean no body.
          const stream = serialized.body;
          if (!stream) {
            proxyBody = await cancellable(() => serialized.blob(), ctx);
          } else {
            const reader = stream.getReader();
            const chunks = [];
            try {
              for (;;) {
                const chunk = await cancellable(() => reader.read(), ctx);
                if (chunk.done) break;
                chunks.push(chunk.value);
              }
              proxyBody = new Blob(chunks, { type: serialized.headers.get('content-type') || '' });
            } catch (error) { void reader.cancel(error).catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
          }
        }
      }
      const metadata = { version: NETWORK_PROTOCOL_VERSION, headers: [...upstreamHeaders], redirect,
        ...(network.maxRedirects !== undefined ? { maxRedirects: network.maxRedirects } : {}),
        ...(Number.isFinite(deadline) ? { timeoutMs: Math.max(1, deadline - now()) } : {}) };
      const response = await cancellable(() => fetcher(proxyURL.href, {
        method, headers: { [NETWORK_REQUEST_HEADER]: encodeNetworkMetadata(metadata) }, body: proxyBody,
        signal: ctx.signal, credentials: 'omit', redirect: 'error',
        // The proxy carries the same upstream bytes, so Fetch must enforce the
        // caller's integrity requirement on this route as well as the direct one.
        integrity: init.integrity === undefined ? original?.integrity : init.integrity,
        ...(proxyBody instanceof ReadableStream ? { duplex: 'half' } : {}),
      }), ctx);
      ctx.check();
      const encoded = response.headers.get(NETWORK_RESPONSE_HEADER);
      if (!encoded) {
        let error;
        try { error = (await cancellable(() => response.json(), ctx)).error; } catch { /* Report the HTTP status if the proxy did not return JSON. */ }
        throw new NetworkError(error?.code ?? 'RELAY_UNAVAILABLE', error?.message ?? `HTTP proxy returned ${response.status}.`, { status: response.status });
      }
      return wrapResponse(response, ctx, decodeNetworkMetadata(encoded), method, true);
    } catch (error) { ctx.close(); throw ctx.signal.aborted ? ctx.failure() : error; }
  };
}

let sharedTransport;
/** Configure once when the shell (or its worker) loads deployment configuration. */
export function configureNetworkTransport(config) {
  sharedTransport = createNetworkTransport(globalThis.fetch.bind(globalThis), config);
}
/** Successful direct requests never load or await optional proxy configuration. */
export function networkFetch(input, init) {
  sharedTransport ??= createNetworkTransport((...args) => globalThis.fetch(...args), () =>
    /^https?:$/.test(globalThis.location?.protocol)
      ? loadNetworkConfiguration(new URL('../', import.meta.url)) : {});
  return sharedTransport(input, init);
}
