import { networkFetch } from './network-transport.mjs';

/** A catalog choice records metadata; installation downloads the ZIP. */
export function selectCatalogPackage(entry, { php } = {}) {
  const url = new URL(entry?.url);
  if (php !== undefined && (!Array.isArray(php) || !php.length || php.some(value => !/^\d+\.\d+$/.test(value)))) {
    throw new TypeError('Choose an available PHP runtime for this package.');
  }
  return { url: url.href, ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
    ...(entry.sha512 ? { sha512: entry.sha512 } : {}), ...(php ? { php: [...new Set(php)] } : {}) };
}

/** Selected releases and ordinary extension URLs share the normal fetch path.
 * Legacy shared URLs still report an actionable failure, without a file dialog.
 */
export function createPackageFetcher(packages, fetchImpl = networkFetch) {
  const selected = new Set(packages.filter(Boolean).map(entry => entry.url));
  return async (input, init) => {
    try { return await fetchImpl(input, init); }
    catch (error) {
      const url = input instanceof Request ? input.url : String(input);
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      if (!selected.has(url) || signal?.aborted) throw error;
      throw new Error(`Could not download the selected package from ${new URL(url).hostname}. ${error.message}`, { cause: error });
    }
  };
}
