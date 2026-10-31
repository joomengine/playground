/** Direct upstream downloads for releases selected from the live catalogs. */
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;
const downloaded = new Map();
let cachedBytes = 0;

function checkedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new TypeError('A package download requires an HTTPS URL.');
  return url.href;
}

function checkedDigest(value, length) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`, 'i').test(value)) throw new TypeError('The package checksum is invalid.');
  return value.toLowerCase();
}

async function digest(algorithm, bytes) {
  return [...new Uint8Array(await crypto.subtle.digest(algorithm, bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readPackage(response) {
  if (!response.ok) throw new Error(`Package download failed: HTTP ${response.status}.`);
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('The package exceeds 128 MiB.');
  }
  const reader = response.body?.getReader();
  let bytes;
  if (reader) {
    const parts = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) throw new Error('The package exceeds 128 MiB.');
        parts.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.byteLength > MAX_BYTES) throw new Error('The package exceeds 128 MiB.');
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw new Error('The package download is not a ZIP archive.');
  return bytes;
}

/** Verify published checksums, then record the downloaded bytes' SHA-256.
 * When a feed has no checksum (as with Joomla nightlies), this is a content
 * fingerprint for the selected download, not an independent publisher digest.
 * URLs always remain the upstream URLs; bytes are held only in this browser.
 */
function checkSelection(entry, php) {
  const url = checkedURL(entry?.url);
  const expected256 = checkedDigest(entry.sha256, 64);
  const expected512 = checkedDigest(entry.sha512, 128);
  if (php !== undefined && (!Array.isArray(php) || !php.length || php.some(value => !/^\d+\.\d+$/.test(value)))) throw new TypeError('Choose an available PHP runtime for this package.');
  return { url, expected256, expected512 };
}

async function rememberPackage(entry, bytes, php) {
  const { url, expected256, expected512 } = checkSelection(entry, php);
  const sha256 = await digest('SHA-256', bytes);
  if (expected256 && sha256 !== expected256) throw new Error('The downloaded package failed its published SHA-256 checksum.');
  if (expected512 && await digest('SHA-512', bytes) !== expected512) throw new Error('The downloaded package failed its published SHA-512 checksum.');
  const key = `${url}\n${sha256}`;
  if (downloaded.has(key)) { cachedBytes -= downloaded.get(key).byteLength; downloaded.delete(key); }
  while (downloaded.size && cachedBytes + bytes.byteLength > MAX_CACHED_BYTES) {
    const oldest = downloaded.keys().next().value;
    cachedBytes -= downloaded.get(oldest).byteLength;
    downloaded.delete(oldest);
  }
  downloaded.set(key, bytes);
  cachedBytes += bytes.byteLength;
  return { url, sha256, ...(expected512 ? { sha512: expected512 } : {}), ...(php ? { php: [...new Set(php)] } : {}) };
}

export async function resolveDynamicPackage(entry, { php, signal, fetchImpl = globalThis.fetch } = {}) {
  const { url } = checkSelection(entry, php);
  const timeout = AbortSignal.timeout(180_000);
  const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow', signal: downloadSignal });
  } catch (error) {
    if (downloadSignal.aborted) throw downloadSignal.reason;
    const failure = new Error(`The browser could not read the direct package download from ${new URL(url).hostname}. Check the connection and the download host's cross-origin permissions.`, { cause: error });
    failure.code = 'DIRECT_PACKAGE_DOWNLOAD_UNAVAILABLE';
    throw failure;
  }
  const bytes = await readPackage(response);
  return rememberPackage(entry, bytes, php);
}

/** A normal browser download can be supplied locally when an upstream ZIP
 * does not allow cross-origin fetch. It follows exactly the same verification
 * and installation path; the file is never uploaded to a server.
 */
export async function importDynamicPackage(entry, file, { php, signal } = {}) {
  checkSelection(entry, php);
  signal?.throwIfAborted();
  if (!(file instanceof Blob)) throw new TypeError('Choose the downloaded ZIP file.');
  if (file.size > MAX_BYTES) throw new Error('The package exceeds 128 MiB.');
  const bytes = await readPackage(new Response(file));
  signal?.throwIfAborted();
  return rememberPackage(entry, bytes, php);
}

/** Reuse the exact selected download during installation; unchanged default
 * packages and downloads absent from memory use the existing fetch path.
 */
export function createPackageFetcher(packages, fetchImpl = globalThis.fetch, { resolvePackage } = {}) {
  const selected = new Map(packages.filter(Boolean).map(entry => [entry.url, entry]));
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const entry = selected.get(url);
    if (entry && (!init?.method || init.method === 'GET') && (!(input instanceof Request) || input.method === 'GET')) {
      const signal = init?.signal || (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      let bytes = entry.sha256 && downloaded.get(`${url}\n${entry.sha256}`);
      if (!bytes && resolvePackage) {
        const resolved = await resolvePackage(entry, { signal, ...(entry.php ? { php: entry.php } : {}) });
        if (resolved.url !== url || (entry.sha256 && resolved.sha256 !== entry.sha256)
            || (entry.sha512 && resolved.sha512 !== entry.sha512)) throw new Error('The resolved download does not match the selected package.');
        bytes = downloaded.get(`${url}\n${resolved.sha256}`);
      }
      if (bytes) return new Response(bytes.slice(), { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(bytes.byteLength) } });
    }
    return fetchImpl(input, init);
  };
}
