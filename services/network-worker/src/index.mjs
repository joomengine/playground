import {
  NETWORK_PROTOCOL_VERSION,
  NETWORK_REQUEST_HEADER as REQUEST_HEADER,
  NETWORK_RESPONSE_HEADER as RESPONSE_HEADER,
  encodeNetworkMetadata as encodeMetadata,
  decodeNetworkMetadata as decodeMetadata,
} from '../../../src/network-protocol.mjs';

export { encodeMetadata, decodeMetadata };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSPORT_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']);

function cors(response, request) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', request.headers.get('Access-Control-Request-Headers') || '*');
  headers.set('Access-Control-Expose-Headers', `${RESPONSE_HEADER}, Content-Length, Content-Type, Location, ETag, Content-Range, Accept-Ranges`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function upstreamHeaders(request, options) {
  const explicit = options.headers != null;
  const headers = new Headers(options.headers ?? request.headers);
  const connectionHeaders = new Set((headers.get('connection') || '').toLowerCase().split(',').map(name => name.trim()));
  for (const name of [...headers.keys()]) {
    const internal = name === REQUEST_HEADER.toLowerCase() || name === RESPONSE_HEADER.toLowerCase();
    const ambient = !explicit && (name === 'origin' || name === 'referer' || name.startsWith('cf-'));
    if (TRANSPORT_HEADERS.has(name) || connectionHeaders.has(name) || internal || ambient) headers.delete(name);
  }
  return headers;
}
function responseHeaders(headers, decoded) {
  const pairs = [];
  for (const [name, value] of headers) {
    if (name === 'set-cookie' || name === 'transfer-encoding' || name === 'connection') continue;
    if (decoded && (name === 'content-encoding' || name === 'content-length')) continue;
    pairs.push([name, value]);
  }
  for (const cookie of headers.getSetCookie?.() ?? headers.getAll?.('Set-Cookie') ?? []) pairs.push(['set-cookie', cookie]);
  return pairs;
}

/** Preserve redirect counts, upload semantics and cross-origin credentials consistently. */
async function fetchUpstream(fetcher, target, request, options, signal) {
  const mode = options.redirect ?? 'follow';
  // Twenty is Fetch's normal redirect ceiling; PHP can provide its own limit
  // or -1 for unlimited redirects.
  const maxRedirects = options.maxRedirects === -1 ? Infinity
    : Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0 ? options.maxRedirects : 20;
  let url = target;
  let outgoing = new Request(url, {
    method: request.method, headers: upstreamHeaders(request, options),
    body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
    signal, redirect: 'manual',
    ...(request.body ? { duplex: 'half' } : {}),
  });
  let redirectCount = 0;
  for (;;) {
    // A cloned request lets a 307/308 repeat the original upload without first
    // buffering it. No retry is made after a failed or uncertain request.
    const replay = mode === 'follow' && outgoing.body ? outgoing.clone() : null;
    let response;
    try { response = await fetcher(outgoing); }
    catch (error) { replay?.body?.cancel().catch(() => {}); throw error; }
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location || mode === 'manual') {
      replay?.body?.cancel().catch(() => {});
      return { response, url: response.url || url.href, redirectCount, redirected: redirectCount > 0 };
    }
    if (mode === 'error' || redirectCount >= maxRedirects) {
      replay?.body?.cancel().catch(() => {});
      await response.body?.cancel();
      throw Object.assign(new Error(mode === 'error' ? 'The request forbids redirects.' : 'The request exceeded its redirect limit.'), { code: mode === 'error' ? 'UPSTREAM_REDIRECT' : 'TOO_MANY_REDIRECTS' });
    }
    const next = new URL(location, url);
    const headers = new Headers(outgoing.headers);
    if (next.origin !== url.origin) {
      headers.delete('authorization'); headers.delete('cookie'); headers.delete('proxy-authorization');
    }
    const toGet = response.status === 303 && outgoing.method !== 'HEAD' || [301, 302].includes(response.status) && outgoing.method === 'POST';
    if (toGet) {
      for (const name of ['content-type', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
      replay?.body?.cancel().catch(() => {});
    }
    await response.body?.cancel();
    outgoing = new Request(next, { method: toGet ? 'GET' : outgoing.method, headers,
      body: toGet ? null : replay?.body, signal, redirect: 'manual', ...(replay?.body && !toGet ? { duplex: 'half' } : {}) });
    url = next; redirectCount++;
  }
}

/** Anonymous HTTP proxy. PHP response metadata travels separately from its bytes. */
export function createRelayWorker({ fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  return {
    async fetch(request) {
      try {
        const url = new URL(request.url);
        if (url.pathname === '/healthz' && request.method === 'GET') return cors(Response.json({ version: NETWORK_PROTOCOL_VERSION, mode: 'anonymous' }), request);
        if (request.method === 'OPTIONS' && request.headers.has('Access-Control-Request-Method')) return cors(new Response(null, { status: 204 }), request);
        const target = new URL(url.searchParams.get('url'));
        const encoded = request.headers.get(REQUEST_HEADER);
        const options = encoded ? decodeMetadata(encoded) : {};
        const signal = options.timeoutMs > 0
          ? AbortSignal.any([request.signal, AbortSignal.timeout(Math.ceil(options.timeoutMs))])
          : request.signal;
        const result = await fetchUpstream(fetcher, target, request, options, signal);
        const upstream = result.response;
        if (!encoded) return cors(upstream, request);
        const hasBody = request.method !== 'HEAD' && ![204, 205, 304].includes(upstream.status) && upstream.body;
        const encoding = upstream.headers.get('content-encoding')?.toLowerCase();
        // Workerd decodes gzip and br. Its deflate response still needs decoding.
        const decoded = hasBody && ['gzip', 'br', 'deflate'].includes(encoding);
        const body = !hasBody ? null : encoding === 'deflate' ? upstream.body.pipeThrough(new DecompressionStream('deflate')) : upstream.body;
        const metadata = { version: NETWORK_PROTOCOL_VERSION, status: upstream.status, statusText: upstream.statusText,
          headers: responseHeaders(upstream.headers, decoded), url: result.url, redirected: !!result.redirected, redirectCount: result.redirectCount };
        return cors(new Response(body, { headers: { [RESPONSE_HEADER]: encodeMetadata(metadata), 'Content-Type': 'application/octet-stream' } }), request);
      } catch (error) {
        const aborted = request.signal.aborted;
        return cors(Response.json({ error: { code: aborted ? 'REQUEST_ABORTED' : error.name === 'TimeoutError' ? 'UPSTREAM_TIMEOUT' : typeof error.code === 'string' ? error.code : 'NETWORK_ERROR', message: error.message } }, { status: aborted ? 499 : 502 }), request);
      }
    },
  };
}
export default createRelayWorker();
