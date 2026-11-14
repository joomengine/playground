/** Complete, intentional site archives. Live-site persistence uses separate stores. */
const DEFAULT_BASE = new URL('../', import.meta.url).href;
export const BACKUP_STORAGE_MARGIN = 10 * 1024 * 1024;
const MIME = 'application/zip';

function timestamp(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('The backup timestamp is invalid.');
  return date.toISOString();
}

export function backupFilename(name, at = new Date()) {
  const stem = String(name || 'joomla-site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'joomla-site';
  return `${stem}-backup-${timestamp(at).replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')}.zip`;
}

export function archiveBlob(archive) {
  const blob = archive?.blob instanceof Blob ? archive.blob
    : archive?.bytes instanceof Uint8Array || archive?.bytes instanceof ArrayBuffer ? new Blob([archive.bytes], { type: MIME }) : null;
  if (!blob?.size) throw new TypeError('A complete, nonempty site archive is required.');
  return blob;
}

export function backupStorageCapacity(size, estimate, margin = BACKUP_STORAGE_MARGIN) {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(margin) || margin < 0) throw new TypeError('Invalid backup storage size.');
  const quota = estimate?.quota, usage = estimate?.usage;
  if (!Number.isFinite(quota) || !Number.isFinite(usage) || quota < 0 || usage < 0) return { known: false, required: size + margin };
  const available = Math.max(0, quota - usage);
  return { known: true, quota, usage, available, required: size + margin, fits: available >= size + margin };
}

/** Blob and listing metadata commit together, including replacements. */
export function createIndexedDBBackupStorage({ indexedDB = globalThis.indexedDB, baseURL = DEFAULT_BASE } = {}) {
  let opening;
  const open = () => opening ??= new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('Browser backup storage is unavailable.')); return; }
    const request = indexedDB.open(`joomengine-site-backups:${new URL(baseURL).pathname}`, 1);
    let abandoned = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('backups')) database.createObjectStore('backups', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('archives')) database.createObjectStore('archives');
    };
    request.onerror = () => reject(request.error || new Error('Browser backup storage is unavailable.'));
    request.onblocked = () => { abandoned = true; reject(new Error('Close other Playground windows before opening backup storage.')); };
    request.onsuccess = () => {
      const database = request.result;
      if (abandoned) { database.close(); return; }
      database.onversionchange = () => { database.close(); opening = undefined; };
      database.onclose = () => { opening = undefined; };
      resolve(database);
    };
  }).catch(error => { opening = undefined; throw error; });
  const transaction = async (mode, operation) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      try { tx = database.transaction(['backups', 'archives'], mode); }
      catch (error) { opening = undefined; reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = event => reject(failure || tx.error || event?.target?.error || new Error('Browser backup storage could not complete the operation.'));
      try { operation(tx, value => { result = value; }, error => { failure = error; tx.abort(); }); }
      catch (error) { failure = error; try { tx.abort(); } catch { reject(error); } }
    });
  };
  return {
    list: () => transaction('readonly', (tx, done) => {
      const request = tx.objectStore('backups').getAll(); request.onsuccess = () => done(request.result);
    }),
    get: id => transaction('readonly', (tx, done) => {
      const metadata = tx.objectStore('backups').get(id), archive = tx.objectStore('archives').get(id);
      let ready = 0;
      const complete = () => { if (++ready === 2) done(metadata.result && archive.result ? { ...metadata.result, blob: archive.result } : null); };
      metadata.onsuccess = complete; archive.onsuccess = complete;
    }),
    put(record, blob, expectedRevision = null) {
      return transaction('readwrite', (tx, done, abort) => {
        const metadata = tx.objectStore('backups'), previous = metadata.get(record.id);
        previous.onsuccess = () => {
          try {
            if ((previous.result?.revision ?? null) !== expectedRevision) {
              const error = new Error('The backup changed in another window.'); error.name = 'BackupConflictError'; abort(error); return;
            }
            metadata.put(record); tx.objectStore('archives').put(blob, record.id);
          } catch (error) {
            abort(error);
          }
        };
      });
    },
    remove: id => transaction('readwrite', tx => { tx.objectStore('backups').delete(id); tx.objectStore('archives').delete(id); }),
    clear: () => transaction('readwrite', tx => { tx.objectStore('backups').clear(); tx.objectStore('archives').clear(); }),
  };
}

export function createSiteBackups({ baseURL = DEFAULT_BASE, storage = createIndexedDBBackupStorage({ baseURL }),
  estimate = () => globalThis.navigator?.storage?.estimate?.(), now = () => new Date(),
  makeId = () => crypto.randomUUID(), margin = BACKUP_STORAGE_MARGIN } = {}) {
  let queue = Promise.resolve();
  const serial = operation => {
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  };
  const usage = async () => { try { return await estimate() ?? null; } catch { return null; } };
  const list = async () => (await storage.list()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id));
  return {
    list, usage,
    async get(id) {
      const record = await storage.get(id);
      if (!record) throw new Error('This backup is no longer available.');
      if (!(record.blob instanceof Blob) || record.blob.size !== record.size) throw new Error('The stored backup archive is incomplete.');
      return record;
    },
    remove: id => serial(() => storage.remove(id)),
    clear: () => serial(() => storage.clear()),
    saveArchive(archive, { id, name, configuration, sourceSiteKey, expectedRevision } = {}) {
      // Capture the bytes before a worker can transfer or reuse the source buffer.
      const blob = archiveBlob(archive);
      return serial(async () => {
        const { bytes: _bytes, ...details } = archive;
        const fallback = { ...details, blob };
        let previous;
        try {
          if (id) {
            previous = await storage.get(id);
            if (!previous) throw new Error('The backup selected for update is no longer available.');
            // The archive can take time to create. Do not overwrite a version
            // changed by another window since the user chose this backup.
            if (expectedRevision !== undefined && previous.revision !== expectedRevision) {
              const error = new Error('The backup changed in another window.'); error.name = 'BackupConflictError'; throw error;
            }
          }
          const at = timestamp(now());
          const metadata = archive.metadata ?? {};
          const config = structuredClone(configuration ?? metadata.playground?.configuration ?? {});
          const title = String(name ?? previous?.name ?? metadata.siteName ?? config.siteName ?? 'Joomla site').trim().slice(0, 160) || 'Joomla site';
          const record = {
            id: id || makeId(), schemaVersion: 1, revision: (previous?.revision ?? 0) + 1,
            name: title, size: blob.size, createdAt: previous?.createdAt ?? at, updatedAt: at,
            capturedAt: metadata.createdAt || metadata.exportedAt || at,
            filename: backupFilename(title, at), mimeType: MIME,
            siteName: metadata.siteName || config.siteName || title,
            joomlaVersion: metadata.joomlaVersion || config.joomlaVersion || '',
            jcbVersion: config.jcbVersion || '', phpVersion: config.phpVersion || metadata.phpVersion || '',
            deploymentId: config.deployId || '', configuration: config,
            ...(sourceSiteKey ? { sourceSiteKey } : {}),
          };
          const capacity = backupStorageCapacity(blob.size, await usage(), margin);
          if (capacity.known && !capacity.fits) return { saved: false, reason: 'space', archive: fallback, previous, capacity };
          await storage.put(record, blob, previous?.revision ?? null);
          return { saved: true, record, capacity };
        } catch (error) {
          return { saved: false, reason: error?.name === 'BackupConflictError' ? 'conflict' : 'storage', error, archive: fallback, previous };
        }
      });
    },
  };
}
