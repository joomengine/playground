import { resolvePublicAssetURL } from './public-assets.mjs';

export const NESTED_PHP_REQUEST_ERROR = 'Nested HTTP requests to the same running PHP site are not supported by this runtime.';

const publicHeaders = new Set(['accept', 'accept-language']);

/** Only anonymous image reads use the relay. Unrelated/authenticated HTTP retains its exact path. */
export function publicImageFetchOptions(input, init, url, options) {
  const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (!['GET', 'HEAD'].includes(method) || init?.body != null) return null;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if ([...headers.keys()].some(name => !publicHeaders.has(name))) return null;
  const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
  if (credentials === 'include' || url.username || url.password) return null;
  const mapped = resolvePublicAssetURL(url.href, options);
  if (mapped === url.href) return null;
  const request = input instanceof Request ? input : undefined;
  return {
    url: mapped,
    init: {
      ...init,
      method, headers,
      ...(request ? { signal: request.signal, cache: request.cache, integrity: request.integrity } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
      ...(init?.cache ? { cache: init.cache } : {}),
      ...(init?.integrity ? { integrity: init.integrity } : {}),
      // The SW route performs its own credential-free CORS fetch to the relay.
      mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    },
  };
}

/** A recursive request cannot complete while its sole PHP/database session is busy. */
export function createPhpFetch(fetcher, siteURL, isRequestActive, publicAssets = {}) {
  const site = new URL(siteURL);
  const prefix = `${site.pathname.replace(/\/+$/, '')}/`;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, site);
    if (isRequestActive() && url.origin === site.origin
      && (url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix))) {
      // Reject through native cURL's normal error path, keeping PHP alive.
      throw new TypeError(NESTED_PHP_REQUEST_ERROR);
    }
    const mapped = publicImageFetchOptions(input, init, url, publicAssets);
    return mapped ? fetcher(mapped.url, mapped.init) : fetcher(input, init);
  };
}
