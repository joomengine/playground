/** Read the small, verified catalog published with this Playground build. */
const DEFAULT_URL = new URL('../assets/version-catalog.json', import.meta.url);
const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\d*(?:-dev)?|-dev)?$/i;
const MAX_BYTES = 1024 * 1024;

export function normalizeVersionCatalog(value, { url = DEFAULT_URL } = {}) {
  const base = new URL(url);
  if (!value || value.schemaVersion !== 1 || !Number.isFinite(Date.parse(value.generatedAt))
    || !Array.isArray(value.joomla) || !Array.isArray(value.jcb) || value.joomla.length > 50 || value.jcb.length > 50) {
    throw new TypeError('The published version catalog is invalid.');
  }
  const normalize = (entries, product) => {
    const seen = new Set();
    return entries.map(entry => {
      const major = Number(entry?.version?.split('.')[0]);
      if (!entry || !VERSION.test(entry.version) || major < 5 || (product === 'joomla' && major > 7)
        || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '') || seen.has(entry.version)) {
        throw new TypeError('The published version catalog contains an invalid or duplicate package.');
      }
      const sha256 = entry.sha256.toLowerCase();
      const pinnedJoomla = product === 'joomla' && entry.channel === 'stable'
        && entry.url === `joomla/Joomla_${entry.version}.zip`;
      if (entry.url !== `packages/${sha256}.zip` && !pinnedJoomla) throw new TypeError('Published packages must use their verified local ZIP.');
      const packageURL = new URL(entry.url, base);
      if (packageURL.origin !== base.origin) throw new TypeError('Published packages must remain on the Playground origin.');
      if (entry.sha512 != null && !/^[a-f0-9]{128}$/i.test(entry.sha512)) throw new TypeError('The published package SHA-512 is invalid.');
      if (entry.phpMinimum !== undefined && !/^\d+\.\d+\.\d+$/.test(entry.phpMinimum)) throw new TypeError('The published PHP minimum is invalid.');
      if (entry.php !== undefined && (!Array.isArray(entry.php) || !entry.php.length || entry.php.some(version => !/^\d+\.\d+$/.test(version)))) {
        throw new TypeError('The published PHP compatibility is invalid.');
      }
      if (!['stable', 'nightly', 'preview'].includes(entry.channel)) throw new TypeError('The published version channel is invalid.');
      seen.add(entry.version);
      return { ...entry, url: packageURL.href, sha256,
        ...(entry.sha512 ? { sha512: entry.sha512.toLowerCase() } : {}), ...(entry.php ? { php: [...entry.php] } : {}) };
    });
  };
  return { schemaVersion: 1, generatedAt: value.generatedAt,
    joomla: normalize(value.joomla, 'joomla'), jcb: normalize(value.jcb, 'jcb'), errors: [] };
}

export async function loadVersionCatalog({ url = DEFAULT_URL, fetchImpl = globalThis.fetch, signal } = {}) {
  const target = new URL(url);
  const response = await fetchImpl(target.href, { cache: 'no-cache', credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The version catalog is unavailable (HTTP ${response.status}).`);
  if (response.url && new URL(response.url).origin !== target.origin) throw new Error('The version catalog redirected away from the Playground origin.');
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('The version catalog exceeds its size limit.');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES) throw new Error('The version catalog exceeds its size limit.');
  return normalizeVersionCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), { url: target });
}

/** Catalog packages need no custom-code prompt; any changed identity still does. */
export function withoutCatalogPackages(input, catalog) {
  const result = { ...input };
  for (const product of ['joomla', 'jcb']) {
    const selected = input[`${product}Package`];
    if (!selected) continue;
    const trusted = catalog[product]?.find(entry => entry.version === input[`${product}Version`]
      && entry.url === selected.url && entry.sha256 === selected.sha256
      && (entry.sha512 || undefined) === (selected.sha512 || undefined)
      && (product !== 'joomla' || JSON.stringify(entry.php) === JSON.stringify(selected.php)));
    if (trusted) delete result[`${product}Package`];
  }
  return result;
}
