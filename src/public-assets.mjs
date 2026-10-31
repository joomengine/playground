/** Reviewed public-image permissions. This module is shared by the browser and relay. */
export const PUBLIC_ASSET_ROUTE = '__public-assets/';
export const PUBLIC_ASSET_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const token = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const validatedRegistries = new WeakSet();

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  return value;
}

/** No credentials, fragments, encoded controls, non-HTTPS schemes or implicit URL normalization. */
export function canonicalPublicAssetURL(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) throw new TypeError('Invalid public image URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== value
    || !url.hostname) throw new TypeError('Public image URLs must be canonical HTTPS URLs without credentials.');
  return url.href;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export function validatePublicAssetRegistry(input) {
  record(input, 'Public image registry');
  if (validatedRegistries.has(input)) return input;
  if (input.schemaVersion !== 1 || !token.test(input.version) || !Array.isArray(input.assets)
    || input.assets.length > 512) throw new TypeError('Unsupported public image registry schema/version.');
  const ids = new Set(), urls = new Set();
  for (const asset of input.assets) {
    record(asset, 'Public image');
    if (!token.test(asset.id) || ids.has(asset.id)) throw new TypeError('Invalid or duplicate public image ID.');
    const url = canonicalPublicAssetURL(asset.url);
    if (urls.has(url)) throw new TypeError('Duplicate public image URL.');
    if (typeof asset.owner !== 'string' || !asset.owner.trim() || asset.owner.length > 200
      || !PUBLIC_ASSET_MIMES.includes(asset.mime) || !Number.isSafeInteger(asset.maxBytes)
      || asset.maxBytes < 1 || asset.maxBytes > 16 * 1024 * 1024
      || typeof asset.compatibilityRequired !== 'boolean') throw new TypeError(`Invalid public image contract: ${asset.id}.`);
    if (!Array.isArray(asset.redirects) || asset.redirects.length > 3
      || new Set(asset.redirects).size !== asset.redirects.length) throw new TypeError(`Invalid redirects: ${asset.id}.`);
    asset.redirects.forEach(canonicalPublicAssetURL);
    if (asset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new TypeError(`Invalid SHA-256: ${asset.id}.`);
    if (asset.md5 !== undefined && !/^[a-f0-9]{32}$/.test(asset.md5)) throw new TypeError(`Invalid source MD5: ${asset.id}.`);
    if (asset.validation !== undefined) {
      record(asset.validation, 'Reviewed image validation');
      const tail = record(asset.validation.gifTrailingData, 'Reviewed GIF trailing data');
      if (Object.keys(asset.validation).length !== 1 || Object.keys(tail).some(key => !['trailerOffset', 'byteLength'].includes(key))
        || asset.mime !== 'image/gif' || !asset.sha256 || !Number.isSafeInteger(tail.trailerOffset)
        || !Number.isSafeInteger(tail.byteLength) || tail.trailerOffset < 13
        || tail.byteLength <= tail.trailerOffset + 1 || tail.byteLength > asset.maxBytes) {
        throw new TypeError(`Invalid reviewed GIF trailing-data allowance: ${asset.id}.`);
      }
    }
    record(asset.cache, 'Public image cache');
    if (!['pinned', 'revalidate'].includes(asset.updatePolicy)
      || typeof asset.cache.immutable !== 'boolean' || !Number.isSafeInteger(asset.cache.maxAgeSeconds)
      || asset.cache.maxAgeSeconds < 0 || asset.cache.maxAgeSeconds > 31_536_000
      || (asset.updatePolicy === 'pinned' && !asset.sha256)
      || (asset.cache.immutable && asset.updatePolicy !== 'pinned')
      || (asset.updatePolicy === 'revalidate' && (asset.cache.immutable || asset.cache.maxAgeSeconds > 3600))) {
      throw new TypeError(`Invalid public image cache/update policy: ${asset.id}.`);
    }
    ids.add(asset.id); urls.add(url);
  }
  const result = freeze(structuredClone(input));
  validatedRegistries.add(result);
  return result;
}

export function validatePublicAssetConfiguration(input) {
  record(input, 'Public image configuration');
  if (input.schemaVersion !== 1 || typeof input.enabled !== 'boolean'
    || !Array.isArray(input.registryVersions) || !input.registryVersions.length
    || input.registryVersions.some(version => !token.test(version))
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 20_000) {
    throw new TypeError('Invalid public image configuration.');
  }
  if (input.relayBaseURL !== null) {
    const url = new URL(canonicalPublicAssetURL(input.relayBaseURL));
    if (url.search || !url.pathname.endsWith('/')) throw new TypeError('Relay base URL must end in / and have no query.');
  } else if (input.enabled) throw new TypeError('An enabled public image relay requires a deployed HTTPS URL.');
  return freeze(structuredClone(input));
}

export async function loadPublicAssetConfiguration(baseURL, fetcher = fetch) {
  const base = new URL('./', baseURL);
  const results = await Promise.all(['config/public-assets.json', 'config/public-assets-config.json'].map(async path => {
    const response = await fetcher(new URL(path, base), { credentials: 'same-origin', cache: 'no-cache' });
    if (!response.ok) throw new Error(`Public image configuration unavailable (${response.status}).`);
    return response.json();
  }));
  const registry = validatePublicAssetRegistry(results[0]);
  const config = validatePublicAssetConfiguration(results[1]);
  if (!config.registryVersions.includes(registry.version)) throw new Error('Public image registry version is not enabled by this client configuration.');
  return Object.freeze({ registry, config, baseURL: base.href });
}

export function findApprovedAsset(registry, value) {
  if (!registry) return undefined;
  let url;
  try { url = canonicalPublicAssetURL(value instanceof URL ? value.href : value); } catch { return undefined; }
  return validatePublicAssetRegistry(registry).assets.find(asset => asset.url === url);
}

export function assetRouteURL(asset, registry, baseURL) {
  if (!token.test(asset?.id) || !token.test(registry?.version)) throw new TypeError('Invalid public image identity.');
  return new URL(`${PUBLIC_ASSET_ROUTE}${registry.version}/${asset.id}`, new URL('./', baseURL)).href;
}

/** A runtime-only decision; never write the returned route into Joomla content or metadata. */
export function resolvePublicAssetURL(value, { policy, registry, config, baseURL } = {}) {
  const original = value instanceof URL ? value.href : String(value);
  if (policy !== 'require-corp' || !registry || !config?.enabled) return original;
  const asset = findApprovedAsset(registry, original);
  return asset?.compatibilityRequired ? assetRouteURL(asset, registry, baseURL) : original;
}

export function parsePublicAssetRoute(value, baseURL) {
  const url = new URL(value), base = new URL('./', baseURL);
  const prefix = `${base.pathname}${PUBLIC_ASSET_ROUTE}`;
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return null;
  const parts = url.pathname.slice(prefix.length).split('/');
  if (url.search || url.hash || parts.length !== 2 || parts.some(part => !token.test(part))) {
    throw new TypeError('Invalid public image route.');
  }
  return { version: parts[0], id: parts[1] };
}

export function publicAssetCacheKey(registry, asset) {
  return `${registry.version}/${asset.id}/${asset.sha256 ?? asset.md5 ?? 'mutable'}`;
}

/** A strict raster signature check; active SVG and generic image/* are deliberately unsupported. */
export function imageBytesMatchMime(bytes, mime) {
  if (!(bytes instanceof Uint8Array)) return false;
  const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (mime === 'image/png') return bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
    && ascii(12, 4) === 'IHDR';
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (mime === 'image/gif') return bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) && bytes[bytes.length - 1] === 59;
  if (mime === 'image/webp') return bytes.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 4));
  return false;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
