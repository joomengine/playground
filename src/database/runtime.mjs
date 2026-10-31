/** Private runtime mounting for Adminer; never writes into the exported site. */
export const ADMINER_VERSION = '6.2.0';
export const ADMINER_DIRECTORY = '/internal/adminer';
export const ADMINER_ROUTE = '__adminer/';
const NAMES = ['adminer.php', 'index.php', 'adminer.css', 'bridge.js'];
const PUBLIC_PATHS = new Set(['', 'index.php', 'adminer.css', 'bridge.js']);
const mounts = new WeakMap();

export function adminerRequestPath(input, sitePrefix, origin) {
  const url = new URL(typeof input === 'string' ? input : input.url, origin);
  const prefix = `${sitePrefix.replace(/\/+$/, '')}/${ADMINER_ROUTE}`;
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith(prefix)) return null;
  return { url, prefix, path: url.pathname.slice(prefix.length) };
}

export function validateAdminerManifest(value) {
  if (!value || value.version !== ADMINER_VERSION || !Array.isArray(value.files) || value.files.length !== NAMES.length) {
    throw new Error('Adminer assets have an unsupported version or incomplete inventory.');
  }
  const names = new Set();
  for (const file of value.files) {
    if (!NAMES.includes(file?.name) || names.has(file.name) || !Number.isSafeInteger(file.bytes)
        || file.bytes < 1 || file.bytes > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Adminer assets have an invalid integrity inventory.');
    }
    names.add(file.name);
  }
  return value;
}

async function readBounded(response, maximum, signal) {
  if (!response.ok || response.type === 'opaque') throw new Error(`Adminer asset download failed (${response.status}).`);
  const expected = Number(response.headers.get('content-length'));
  if (expected > maximum) throw new Error('Adminer asset exceeds its size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Adminer asset download returned no bytes.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Adminer asset exceeds its size limit.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function installAdminer({ fs, baseURL, fetcher = fetch, signal } = {}) {
  const current = mounts.get(fs);
  if (current && fs.analyzePath(`${ADMINER_DIRECTORY}/index.php`).exists) return current;
  if (current) mounts.delete(fs);
  const operation = (async () => {
    const base = new URL('assets/adminer/', baseURL);
    if (base.origin !== new URL(baseURL).origin) throw new Error('Adminer assets must share the Playground origin.');
    const timeout = AbortSignal.timeout(30_000);
    const downloadSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const options = { credentials: 'omit', redirect: 'error', signal: downloadSignal };
    const manifestBytes = await readBounded(await fetcher(new URL('manifest.json', base), options), 16 * 1024, downloadSignal);
    const manifest = validateAdminerManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const files = [];
    for (const entry of manifest.files) {
      const bytes = await readBounded(await fetcher(new URL(entry.name, base), options), entry.bytes, downloadSignal);
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (bytes.length !== entry.bytes || hash !== entry.sha256) throw new Error(`Adminer ${entry.name} failed integrity verification.`);
      files.push({ name: entry.name, bytes });
    }
    // Verify the whole set before making the entry point executable.
    fs.mkdirTree(ADMINER_DIRECTORY);
    for (const entry of files.filter(file => file.name !== 'index.php')) fs.writeFile(`${ADMINER_DIRECTORY}/${entry.name}`, entry.bytes);
    fs.writeFile(`${ADMINER_DIRECTORY}/index.php`, files.find(file => file.name === 'index.php').bytes);
    return { version: manifest.version, bytes: manifest.files.reduce((n, file) => n + file.bytes, 0) };
  })();
  mounts.set(fs, operation);
  try { return await operation; }
  catch (error) { if (mounts.get(fs) === operation) mounts.delete(fs); throw error; }
}

/** The owner serializes requests, so the temporary CGI route cannot overlap Joomla. */
export async function withAdminerRequest({ php, fs, request, sitePrefix, origin, execute }) {
  const route = adminerRequestPath(request, sitePrefix, origin);
  if (!route) return execute(request);
  const plain = (status, message) => ({ status, statusText: '', headers: [['content-type', 'text/plain; charset=utf-8'], ['cache-control', 'no-store']],
    body: new TextEncoder().encode(message), databaseUsed: false });
  if (!PUBLIC_PATHS.has(route.path)) return plain(404, 'Unknown Database tool route.');
  if (!fs.analyzePath(`${ADMINER_DIRECTORY}/index.php`).exists) return plain(409, 'Open Database from the Playground toolbar first.');
  const previousRoot = php.docroot, previousPrefix = php.prefix;
  php.docroot = ADMINER_DIRECTORY;
  php.prefix = route.prefix;
  try { return await execute(request); }
  finally { php.docroot = previousRoot; php.prefix = previousPrefix; }
}
