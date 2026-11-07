import { networkFetch } from '../network-transport.mjs';

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
    if (!NAMES.includes(file?.name) || names.has(file.name)) {
      throw new Error('Adminer assets have an invalid file inventory.');
    }
    names.add(file.name);
  }
  return value;
}

export async function installAdminer({ fs, baseURL, fetcher = networkFetch, signal } = {}) {
  const current = mounts.get(fs);
  if (current && fs.analyzePath(`${ADMINER_DIRECTORY}/index.php`).exists) return current;
  if (current) mounts.delete(fs);
  const operation = (async () => {
    const base = new URL('assets/adminer/', baseURL);
    const options = { signal };
    const response = await fetcher(new URL('manifest.json', base), options);
    if (!response.ok) throw new Error(`Adminer manifest download failed (${response.status}).`);
    const manifest = validateAdminerManifest(await response.json());
    const files = [];
    for (const entry of manifest.files) {
      const response = await fetcher(new URL(entry.name, base), options);
      if (!response.ok) throw new Error(`Adminer ${entry.name} download failed (${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      files.push({ name: entry.name, bytes });
    }
    // Download the whole set before mounting the entry point.
    fs.mkdirTree(ADMINER_DIRECTORY);
    for (const entry of files.filter(file => file.name !== 'index.php')) fs.writeFile(`${ADMINER_DIRECTORY}/${entry.name}`, entry.bytes);
    fs.writeFile(`${ADMINER_DIRECTORY}/index.php`, files.find(file => file.name === 'index.php').bytes);
    return { version: manifest.version, bytes: files.reduce((n, file) => n + file.bytes.byteLength, 0) };
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
