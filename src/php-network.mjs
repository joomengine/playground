export const NESTED_PHP_REQUEST_ERROR = 'Nested HTTP requests to the same running PHP site are not supported by this runtime.';

/** A recursive request cannot complete while its sole PHP/database session is busy. */
export function createPhpFetch(fetcher, siteURL, isRequestActive) {
  const site = new URL(siteURL);
  const prefix = `${site.pathname.replace(/\/+$/, '')}/`;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, site);
    if (isRequestActive() && url.origin === site.origin
      && (url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix))) {
      // Reject through native cURL's normal error path, keeping PHP alive.
      throw new TypeError(NESTED_PHP_REQUEST_ERROR);
    }
    return fetcher(input, init);
  };
}
