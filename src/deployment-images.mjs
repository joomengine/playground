/** Immutable prepared sites, stored independently from running site databases. */
const CACHE_VERSION = 1;
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_BASE = new URL('../', import.meta.url).href;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => [key, canonical(value[key])]));
}
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function imageBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('The prepared image has an invalid size.');
  return bytes;
}
function publicRecord(record, available = true) {
  return Object.fromEntries(Object.entries({ key: record.key, kind: record.kind,
    deploymentId: record.deploymentId, title: record.title, joomlaVersion: record.joomlaVersion,
    phpVersion: record.phpVersion, size: record.size, createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt, available }).filter(([, value]) => value !== undefined));
}

/** Exact build inputs identify custom images; credentials never enter metadata. */
export async function deploymentImageFingerprint(config, manifest, { baseURL = DEFAULT_BASE } = {}) {
  const php = manifest.php?.find(entry => entry.version === config.phpVersion);
  const joomla = config.joomlaPackage || manifest.joomla?.find(entry => entry.version === config.joomlaVersion);
  const fields = ['deployId', 'sourceDeployId', 'joomlaVersion', 'phpVersion', 'jcbVersion', 'jcbPackage', 'language',
    'languageTags', 'multilingual', 'extensions', 'startupCommands', 'languages', 'menus', 'template', 'content', 'phpSettings'];
  const configuration = Object.fromEntries(fields.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  // Arbitrary console commands may read the current site/account identity. Keep
  // those builds separate, while ordinary recipes can personalise one base.
  if (config.startupCommands?.length) {
    configuration.siteName = config.siteName;
    configuration.administrator = Object.fromEntries(['name', 'username', 'email']
      .filter(key => config.admin?.[key] !== undefined).map(key => [key, config.admin[key]]));
  }
  const snapshot = deploymentSnapshotSource(config, manifest, baseURL);
  return digest(new TextEncoder().encode(JSON.stringify(canonical({ version: CACHE_VERSION,
    sourceCommit: manifest.sourceCommit, upstream: manifest.upstream, bridge: manifest.bridge,
    nativeDriver: manifest.nativeDriver, php, joomla,
    baseImage: snapshot ? { url: snapshot.url, sha256: snapshot.sha256, joomlaVersion: snapshot.joomlaVersion } : undefined,
    configuration }))));
}

/** An explicit snapshot is authoritative unless its URL identifies a maintained image. */
export function deploymentSnapshotSource(config, manifest, baseURL = DEFAULT_BASE) {
  if (!config.snapshot) return null;
  const snapshot = config.snapshot;
  if (typeof snapshot.url !== 'string' || !HASH.test(snapshot.sha256 || '')
    || snapshot.joomlaVersion !== config.joomlaVersion) throw new TypeError('The prepared image configuration is invalid.');
  const url = new URL(snapshot.url, baseURL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new TypeError('The prepared image URL is invalid.');
  }
  const maintained = maintainedDeploymentImages(manifest, baseURL).find(entry => entry.deploymentId === config.deployId
    && entry.joomlaVersion === config.joomlaVersion && entry.url === url.href);
  return { url: url.href, sha256: maintained?.sha256 ?? snapshot.sha256,
    joomlaVersion: snapshot.joomlaVersion, maintained: maintained ?? null };
}

/** A complete local image already contains its packages, commands and template. */
export function completedDeploymentImageConfiguration(config) {
  const restored = { ...config, addonExtensions: [], addonStartupCommands: [], addonLanguages: [] };
  if (config.template) {
    const { url, sha256, ...template } = config.template;
    restored.template = template;
  }
  return restored;
}

/** The published manifest is the only authority for maintained image hashes. */
export function maintainedDeploymentImages(manifest, baseURL = DEFAULT_BASE) {
  const base = new URL(baseURL);
  const manifestURL = new URL('assets/manifest.json', base);
  const seen = new Set();
  return (manifest.prebuiltDeploys || []).map(entry => {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id)
      || typeof entry.joomlaVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(entry.joomlaVersion)
      || !HASH.test(entry.sha256 || '') || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_IMAGE_BYTES) {
      throw new Error('The prepared image catalog is invalid.');
    }
    const url = new URL(entry.url, manifestURL);
    if (url.origin !== base.origin || !url.pathname.startsWith(new URL('assets/snapshots/', base).pathname)
      || url.username || url.password || url.search || url.hash) throw new Error('The prepared image catalog is invalid.');
    const key = `server:${entry.id}:${entry.joomlaVersion}`;
    if (seen.has(key)) throw new Error('The prepared image catalog contains a duplicate image.');
    seen.add(key);
    return { key, kind: 'server', deploymentId: entry.id, title: entry.title || entry.id,
      joomlaVersion: entry.joomlaVersion, phpVersion: entry.phpVersion, sha256: entry.sha256,
      size: entry.size, url: url.href };
  });
}

/** Metadata and ZIP bytes commit atomically; listing never reads large blobs. */
export function createIndexedDBImageStorage({ indexedDB = globalThis.indexedDB, baseURL = DEFAULT_BASE } = {}) {
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('Local image storage is unavailable.')); return; }
    let abandoned = false;
    const request = indexedDB.open(`joomengine-deployment-images:${new URL(baseURL).pathname}`, CACHE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('images')) database.createObjectStore('images', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('archives')) database.createObjectStore('archives');
    };
    request.onerror = () => reject(new Error('Local image storage is unavailable.'));
    request.onblocked = () => { abandoned = true; reject(new Error('Close other playground tabs before managing local images.')); };
    request.onsuccess = () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => { database.close(); opening = undefined; };
      resolve(database);
    };
  }).catch(error => { opening = undefined; throw error; });
  const transaction = async (mode, operation) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(['images', 'archives'], mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error('Local image storage could not complete the operation.'));
      operation(tx, value => { result = value; });
    });
  };
  return {
    list: () => transaction('readonly', (tx, done) => {
      const request = tx.objectStore('images').getAll(); request.onsuccess = () => done(request.result);
    }),
    get: key => transaction('readonly', (tx, done) => {
      const metadata = tx.objectStore('images').get(key);
      const archive = tx.objectStore('archives').get(key);
      let metadataReady = false, archiveReady = false;
      const complete = () => { if (metadataReady && archiveReady) done(metadata.result && archive.result ? { ...metadata.result, blob: archive.result } : null); };
      metadata.onsuccess = () => { metadataReady = true; complete(); };
      archive.onsuccess = () => { archiveReady = true; complete(); };
    }),
    put(record, bytes) {
      // Capture before opening the asynchronous transaction: the caller may
      // transfer or reuse its buffer as soon as installation continues.
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/zip' });
      return transaction('readwrite', tx => {
        tx.objectStore('images').put(record);
        tx.objectStore('archives').put(blob, record.key);
      });
    },
    touch: (key, lastUsedAt) => transaction('readwrite', tx => {
      const store = tx.objectStore('images');
      const request = store.get(key);
      request.onsuccess = () => { if (request.result) store.put({ ...request.result, lastUsedAt }); };
    }),
    remove: key => transaction('readwrite', tx => {
      tx.objectStore('images').delete(key); tx.objectStore('archives').delete(key);
    }),
  };
}

export function createDeploymentImageCache({ baseURL = DEFAULT_BASE, storage = createIndexedDBImageStorage({ baseURL }),
  fetcher = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const pending = new Map();
  const warning = (onWarning, message = 'The image could not be saved locally. This site can still launch.') => {
    try { onWarning?.(message); }
    catch { /* An optional cache diagnostic cannot interrupt installation. */ }
  };
  const read = async (key, expected, onWarning) => {
    let record;
    try { record = await storage.get(key); } catch { return null; }
    if (!record) return null;
    if (!HASH.test(record.sha256 || '') || (expected && expected.sha256 !== record.sha256)) {
      await storage.remove(key).catch(() => {}); return null;
    }
    let bytes;
    try { bytes = imageBytes(await record.blob.arrayBuffer()); }
    catch { await storage.remove(key).catch(() => {}); return null; }
    if (record.size !== bytes.byteLength || await digest(bytes) !== record.sha256) {
      await storage.remove(key).catch(() => {}); return null;
    }
    if (storage.touch) void Promise.resolve().then(() => storage.touch(key, now()))
      .catch(() => warning(onWarning, 'The cached image is available, but its last-used time could not be updated.'));
    return { bytes, sha256: record.sha256, cached: true };
  };
  const reconcile = async manifest => {
    const current = maintainedDeploymentImages(manifest, baseURL);
    const expected = new Map(current.map(entry => [entry.key, entry]));
    for (const record of await storage.list()) {
      if (record.kind === 'server' && expected.get(record.key)?.sha256 !== record.sha256) await storage.remove(record.key);
    }
    return current;
  };
  return {
    async list(manifest) {
      const current = manifest ? await reconcile(manifest) : [];
      const records = await storage.list();
      if (!manifest) return records.map(record => publicRecord(record));
      const byKey = new Map(records.map(record => [record.key, record]));
      return [...current.map(entry => publicRecord(byKey.get(entry.key) || entry, byKey.has(entry.key))),
        ...records.filter(record => record.kind === 'custom').map(record => publicRecord(record))];
    },
    remove: key => storage.remove(key),
    reconcile,
    maintained: (config, manifest) => deploymentSnapshotSource(config, manifest, baseURL)?.maintained ?? null,
    async getMaintained(entry, { onProgress = () => {}, onWarning } = {}) {
      if (pending.has(entry.sha256)) {
        const shared = pending.get(entry.sha256);
        const image = await shared.operation;
        return { ...image, bytes: new Uint8Array(await shared.blob.arrayBuffer()) };
      }
      const shared = {};
      shared.operation = (async () => {
        const stored = await read(entry.key, entry, onWarning);
        if (stored) {
          shared.blob = new Blob([stored.bytes], { type: 'application/zip' });
          onProgress({ phase: 'launch-image', message: 'Restoring the image saved in this browser…' }); return stored;
        }
        onProgress({ phase: 'download-image', message: 'Downloading the prepared image…' });
        const response = await fetcher(entry.url);
        if (!response.ok) throw new Error('The prepared image could not be downloaded.');
        const bytes = imageBytes(await response.arrayBuffer());
        if (bytes.byteLength !== entry.size || await digest(bytes) !== entry.sha256) throw new Error('The prepared image failed its integrity check.');
        const { url, ...metadata } = entry;
        shared.blob = new Blob([bytes], { type: 'application/zip' });
        shared.writing = Promise.resolve().then(() => storage.put({ ...metadata, createdAt: now(), lastUsedAt: now() }, shared.blob))
          .catch(() => warning(onWarning)).finally(() => { if (pending.get(entry.sha256) === shared) pending.delete(entry.sha256); });
        return { bytes, sha256: entry.sha256, cached: false };
      })();
      pending.set(entry.sha256, shared);
      try { return await shared.operation; }
      finally { if (!shared.writing && pending.get(entry.sha256) === shared) pending.delete(entry.sha256); }
    },
    getCustom: fingerprint => read(`custom:${fingerprint}`),
    async saveCustom(config, manifest, bytes, { fingerprint, onProgress = () => {}, onWarning } = {}) {
      bytes = imageBytes(bytes);
      fingerprint ||= await deploymentImageFingerprint(config, manifest, { baseURL });
      const sha256 = await digest(bytes);
      onProgress({ phase: 'save-image', message: 'Saving the prepared image for future sites…' });
      const record = { key: `custom:${fingerprint}`, kind: 'custom', deploymentId: config.deployId,
        title: config.deploymentRecipe?.name || config.deploymentName || config.siteName || config.deployId,
        joomlaVersion: config.joomlaVersion, phpVersion: config.phpVersion, sha256,
        size: bytes.byteLength, createdAt: now(), lastUsedAt: now() };
      try { await storage.put(record, bytes); return publicRecord(record); }
      catch { warning(onWarning); return null; }
    },
  };
}

export const deploymentImages = createDeploymentImageCache();
