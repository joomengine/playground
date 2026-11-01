import {
  findApprovedAsset, imageBytesMatchMime, loadPublicAssetConfiguration,
  parsePublicAssetRoute, publicAssetCacheKey, sha256Hex,
  validatePublicAssetConfiguration, validatePublicAssetRegistry,
} from './public-assets.mjs';

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;
const MAX_PENDING_REQUESTS = 16;
const cachesByRegistry = new WeakMap();
const diagnostics = new Map();
let pending = 0;

function diagnostic(assetId, cause, callback) {
  const key = `${assetId}:${cause}`;
  if (diagnostics.has(key)) return;
  if (diagnostics.size >= 32) diagnostics.delete(diagnostics.keys().next().value);
  diagnostics.set(key, true);
  callback?.({ type: 'public-asset-failure', assetId, cause });
}

function failure(status, cause, assetId, callback) {
  diagnostic(assetId, cause, callback);
  return new Response(`Public image ${assetId}: ${cause}`, { status, headers: {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
  } });
}

function cacheFor(registry) {
  let cache = cachesByRegistry.get(registry);
  if (!cache) { cache = { entries: new Map(), bytes: 0 }; cachesByRegistry.set(registry, cache); }
  return cache;
}

function removeCached(cache, key) {
  const entry = cache.entries.get(key);
  if (entry) cache.bytes -= entry.body.byteLength;
  cache.entries.delete(key);
}

function cacheImage(registry, asset, image, now, freshness) {
  if (!freshness || image.body.byteLength > MAX_CACHE_BYTES) return;
  const cache = cacheFor(registry), key = publicAssetCacheKey(registry, asset);
  removeCached(cache, key);
  while (cache.entries.size >= MAX_CACHE_ENTRIES || cache.bytes + image.body.byteLength > MAX_CACHE_BYTES) {
    removeCached(cache, cache.entries.keys().next().value);
  }
  cache.entries.set(key, { ...image, expires: now + freshness * 1000 });
  cache.bytes += image.body.byteLength;
}

function imageResponse(image, asset, method) {
  return new Response(method === 'HEAD' ? null : image.body.slice(), { status: 200, headers: {
    'Content-Type': asset.mime, 'Content-Length': String(image.body.byteLength),
    // Do not let the browser reuse a synthetic external-URL response across policies.
    // The bounded worker cache stores only validated bytes under version/id/content.
    'Cache-Control': 'no-store', 'ETag': `"sha256-${image.sha256}"`,
    // WebKit applies CORP using the ORIGINAL external request URL even when
    // respondWith supplies a synthetic validated response. Public approved
    // raster bytes must explicitly permit that cross-origin embedding.
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin',
  } });
}

async function readBounded(response, maxBytes, signal) {
  const length = response.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel(); throw new Error('relay response exceeds the approved size');
  }
  if (!response.body) throw new Error('relay returned no image bytes');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error('relay response exceeds the approved size'); }
      chunks.push(value);
    }
    if (signal.aborted) throw signal.reason;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const body = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * Handles the reserved asset route and exact approved image embeddings. No HTML,
 * CSS, metadata or saved files are rewritten; original source URLs remain portable.
 */
export async function handlePublicAssetRequest(request, {
  policy, baseURL, registry: inputRegistry, config: inputConfig, fetcher = fetch,
  onDiagnostic, now = Date.now,
} = {}) {
  let route;
  try { route = parsePublicAssetRoute(request.url, baseURL); }
  catch { return failure(400, 'invalid asset route', 'invalid', onDiagnostic); }
  if (policy !== 'require-corp') return route ? failure(403, 'compatibility delivery is not active for this page', route.id, onDiagnostic) : null;
  const registry = validatePublicAssetRegistry(inputRegistry), config = validatePublicAssetConfiguration(inputConfig);
  const asset = route ? registry.assets.find(item => item.id === route.id) :
    request.destination === 'image' ? findApprovedAsset(registry, request.url) : undefined;
  if (!route && (!asset || !asset.compatibilityRequired)) return null;
  if (route && (route.version !== registry.version || !config.registryVersions.includes(route.version))) {
    return failure(404, 'unsupported registry version', route.id, onDiagnostic);
  }
  if (!asset) return failure(404, 'unknown asset ID', route.id, onDiagnostic);
  if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'only GET and HEAD are supported', asset.id, onDiagnostic);
  if (!config.enabled || !config.relayBaseURL) return route ? failure(503, 'the public image relay is not configured', asset.id, onDiagnostic) : null;
  const headers = new Headers(request.headers);
  if (headers.has('Authorization') || headers.has('Proxy-Authorization') || headers.has('Cookie') || headers.has('Range')) {
    return failure(400, 'authenticated or partial image requests are not supported', asset.id, onDiagnostic);
  }
  const cache = cacheFor(registry), key = publicAssetCacheKey(registry, asset), existing = cache.entries.get(key);
  if (existing && existing.expires > now() && !['no-store', 'reload'].includes(request.cache)) return imageResponse(existing, asset, request.method);
  if (existing) removeCached(cache, key);
  if (pending >= MAX_PENDING_REQUESTS) return failure(429, 'image request capacity reached', asset.id, onDiagnostic);
  pending++;
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('image request timed out')), config.timeoutMs);
  try {
    const relayURL = new URL(`v1/assets/${registry.version}/${asset.id}`, config.relayBaseURL);
    // A complete GET is required even for HEAD: cache and validation must never
    // accept an upstream HTML/error/partial representation merely from headers.
    const response = await fetcher(relayURL.href, {
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
      headers: { Accept: asset.mime }, cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (response.status !== 200 || response.type === 'opaque') {
      await response.body?.cancel();
      const status = [400, 404, 405, 413, 422, 429, 503, 504].includes(response.status) ? response.status : 502;
      return failure(status, `relay returned HTTP ${response.status}`, asset.id, onDiagnostic);
    }
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== asset.mime) {
      await response.body?.cancel(); throw new Error('relay image type does not match the registry');
    }
    if (response.headers.get('X-Public-Asset-Id') !== asset.id
      || response.headers.get('X-Public-Asset-Registry') !== registry.version
      || !/^[a-f0-9]{64}$/.test(response.headers.get('X-Public-Asset-SHA256') ?? '')) {
      await response.body?.cancel(); throw new Error('relay image identity does not match the registry');
    }
    const body = await readBounded(response, asset.maxBytes, controller.signal);
    if (!imageBytesMatchMime(body, asset.mime)) throw new Error('relay returned an invalid image format');
    const sha256 = await sha256Hex(body);
    if (asset.sha256 && sha256 !== asset.sha256) throw new Error('approved image SHA-256 mismatch');
    const relayDigest = response.headers.get('X-Public-Asset-SHA256');
    if (relayDigest !== sha256) throw new Error('relay image digest mismatch');
    const image = { body, sha256 };
    const advertised = /(?:^|,)\s*max-age=(\d+)(?:\s|,|$)/i.exec(response.headers.get('Cache-Control') ?? '');
    const age = Number(response.headers.get('Age') ?? 0);
    const freshness = advertised && Number.isSafeInteger(age) && age >= 0
      ? Math.max(0, Math.min(asset.cache.maxAgeSeconds, Number(advertised[1]) - age)) : 0;
    if (request.cache !== 'no-store') cacheImage(registry, asset, image, now(), freshness);
    return imageResponse(image, asset, request.method);
  } catch (error) {
    const reason = controller.signal.aborted ? 'image request cancelled or timed out' :
      ['relay image type does not match the registry', 'relay image identity does not match the registry', 'relay response exceeds the approved size', 'relay returned no image bytes',
        'relay returned an invalid image format', 'approved image SHA-256 mismatch', 'relay image digest mismatch'].includes(error.message)
        ? error.message : 'image relay could not be reached';
    return failure(controller.signal.aborted ? 504 : 502, reason, asset.id, onDiagnostic);
  } finally { pending--; clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}

/** Lazily reads reviewed deployment configuration; normal mode performs no relay/config requests. */
export function createPublicAssetHandler({ baseURL, fetcher = fetch, load = loadPublicAssetConfiguration } = {}) {
  let configuration;
  return async (request, { policy, onDiagnostic } = {}) => {
    let route;
    try { route = parsePublicAssetRoute(request.url, baseURL); }
    catch { return failure(400, 'invalid asset route', 'invalid', onDiagnostic); }
    if (policy !== 'require-corp') return route ? failure(403, 'compatibility delivery is not active for this page', route.id, onDiagnostic) : null;
    if (!route && request.destination !== 'image') return null;
    try {
      configuration ??= load(baseURL, fetcher).catch(error => { configuration = undefined; throw error; });
      return await handlePublicAssetRequest(request, { ...await configuration, policy, baseURL, fetcher, onDiagnostic });
    } catch {
      return route ? failure(503, 'approved image configuration is unavailable', route.id, onDiagnostic) : null;
    }
  };
}
