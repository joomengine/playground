export const MAX_STATIC_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_STATIC_CACHE_BYTES = 16 * 1024 * 1024;

/** Validate the current file contents before reusing a browser-side copy. */
export async function staticAssetResponse(value, request, { staticAsset = false } = {}) {
  if (!staticAsset || value.status !== 200 || !['GET', 'HEAD'].includes(request.method)
    || !(value.body instanceof Uint8Array) || value.body.byteLength > MAX_STATIC_ASSET_BYTES) return value;
  const headers = new Headers(value.headers);
  const digest = await crypto.subtle.digest('SHA-256', value.body);
  const etag = `"${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}"`;
  headers.set('ETag', etag);
  headers.set('Cache-Control', 'private, no-cache');
  const matches = new Headers(request.headers).get('If-None-Match')?.split(',').some(tag => {
    const candidate = tag.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === etag;
  });
  if (matches) {
    headers.delete('Content-Length');
    return { ...value, status: 304, statusText: 'Not Modified', headers: [...headers], body: new Uint8Array(), staticAsset: true };
  }
  return { ...value, headers: [...headers], staticAsset: true };
}

/** A bounded per-session cache; every hit is checked against the running site. */
export class StaticAssetCache {
  #entries = new Map();
  #bytes = 0;

  constructor({ maxBytes = MAX_STATIC_CACHE_BYTES, maxEntryBytes = MAX_STATIC_ASSET_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = maxEntryBytes;
  }

  #delete(url) {
    const previous = this.#entries.get(url);
    if (previous) this.#bytes -= previous.body.byteLength;
    this.#entries.delete(url);
  }

  async respond(request, exchange, { cache = 'default' } = {}) {
    const headers = new Headers(request.headers);
    const eligible = request.method === 'GET' && !headers.has('If-None-Match') && !['reload', 'no-store'].includes(cache);
    const previous = eligible ? this.#entries.get(request.url) : undefined;
    if (previous) headers.set('If-None-Match', new Headers(previous.headers).get('ETag'));
    let response = await exchange({ ...request, headers: [...headers] });
    if (previous && response.status === 304 && response.staticAsset === true
      && new Headers(response.headers).get('ETag') === new Headers(previous.headers).get('ETag')) {
      response = { ...previous, headers: response.headers };
    }
    this.#delete(request.url);
    if (eligible && response.staticAsset === true && response.status === 200
      && response.body instanceof Uint8Array && response.body.byteLength <= this.maxEntryBytes
      && response.body.byteLength <= this.maxBytes && new Headers(response.headers).has('ETag')) {
      while (this.#bytes + response.body.byteLength > this.maxBytes) this.#delete(this.#entries.keys().next().value);
      this.#entries.set(request.url, response);
      this.#bytes += response.body.byteLength;
    }
    return response;
  }
}
