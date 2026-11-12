import { networkCredentialHeaders } from './network-protocol.mjs';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Preserve redirect counts, upload semantics and cross-origin credentials consistently. */
export async function fetchHttpRedirects(fetcher, target, request, options = {}, signal = request.signal) {
  const mode = options.redirect ?? 'follow';
  const credentialHeaders = networkCredentialHeaders(request.headers, options.credentialHeaders);
  const cache = options.cache ?? (credentialHeaders.length ? 'no-store' : request.cache);
  // Twenty is Fetch's normal redirect ceiling; PHP can provide its own limit
  // or -1 for unlimited redirects.
  const maxRedirects = options.maxRedirects === -1 ? Infinity
    : Number.isInteger(options.maxRedirects) && options.maxRedirects >= 0 ? options.maxRedirects : 20;
  let url = target;
  const requestBody = ['GET', 'HEAD'].includes(request.method) ? null : request.body ?? await request.arrayBuffer();
  let outgoing = new Request(url, {
    method: request.method, headers: request.headers,
    body: requestBody,
    signal, redirect: 'manual', cache, credentials: request.credentials,
    integrity: request.integrity, referrerPolicy: request.referrerPolicy,
    ...(requestBody instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
  // The local CGI server accepts HTTP headers that a browser Request normally
  // drops. Keep the explicit header set across request/redirect construction.
  Object.defineProperty(outgoing, 'headers', { value: new Headers(request.headers) });
  let redirectCount = 0;
  for (;;) {
    // A cloned request lets a 307/308 repeat the original upload without first
    // buffering it. No retry is made after a failed or uncertain request.
    const replay = mode === 'follow' && !['GET', 'HEAD'].includes(outgoing.method) ? outgoing.clone() : null;
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
      for (const name of credentialHeaders) headers.delete(name);
    }
    const toGet = response.status === 303 && outgoing.method !== 'HEAD' || [301, 302].includes(response.status) && outgoing.method === 'POST';
    if (toGet) {
      for (const name of ['content-type', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
      replay?.body?.cancel().catch(() => {});
    }
    await response.body?.cancel();
    const body = toGet || !replay ? null : replay.body ?? await replay.arrayBuffer();
    outgoing = new Request(next, { method: toGet ? 'GET' : outgoing.method, headers,
      body, signal, redirect: 'manual', cache, credentials: request.credentials,
      integrity: request.integrity, referrerPolicy: request.referrerPolicy,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
    Object.defineProperty(outgoing, 'headers', { value: headers });
    url = next; redirectCount++;
  }
}

