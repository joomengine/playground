/** A catalog choice records immutable metadata; installation downloads the ZIP. */
export function selectCatalogPackage(entry, { php } = {}) {
  const url = new URL(entry?.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) {
    throw new TypeError('A package requires an HTTPS URL.');
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) throw new TypeError('The selected package requires a SHA-256 checksum.');
  if (entry.sha512 != null && !/^[a-f0-9]{128}$/i.test(entry.sha512)) throw new TypeError('The selected package has an invalid SHA-512 checksum.');
  if (php !== undefined && (!Array.isArray(php) || !php.length || php.some(value => !/^\d+\.\d+$/.test(value)))) {
    throw new TypeError('Choose an available PHP runtime for this package.');
  }
  return { url: url.href, sha256: entry.sha256.toLowerCase(),
    ...(entry.sha512 ? { sha512: entry.sha512.toLowerCase() } : {}), ...(php ? { php: [...new Set(php)] } : {}) };
}

/** Selected releases and ordinary extension URLs share the normal fetch path.
 * The installer verifies their checksums before writing files or invoking PHP.
 * Legacy shared URLs still report an actionable failure, without a file dialog.
 */
export function createPackageFetcher(packages, fetchImpl = globalThis.fetch) {
  const selected = new Set(packages.filter(Boolean).map(entry => entry.url));
  return async (input, init) => {
    try { return await fetchImpl(input, init); }
    catch (error) {
      const url = input instanceof Request ? input.url : String(input);
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      if (!selected.has(url) || signal?.aborted) throw error;
      throw new Error(`Could not download the selected package from ${new URL(url).hostname}. Check your connection and retry. Older shared package URLs must permit browser downloads.`, { cause: error });
    }
  };
}
