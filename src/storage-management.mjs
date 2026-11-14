const identityPattern = /^[a-f0-9]{32}$/;
const runtimeStorePattern = /^(?:\/joomengine-|\/mariadb\/idb\/joomengine-)([a-f0-9]{32})$/;
const registryPrefix = 'joomengine-runtime-storage:';
const draftDatabase = 'joomengine-code-drafts';
const defaultBase = new URL('../', import.meta.url).href;
const browserStorage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
const registryKey = baseURL => registryPrefix + new URL(baseURL).href;

/** Match the identity used by both native runtime filesystems and their Web Lock. */
export async function runtimeStorageIdentity(baseURL, storageKey) {
  if (typeof storageKey !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(storageKey)) throw new TypeError('Invalid site storage key.');
  const bytes = new TextEncoder().encode(`${new URL(baseURL).href}\n${storageKey}`);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function readRegistry(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem(key) || 'null');
    return value?.version === 1 && value.sites && typeof value.sites === 'object' ? value.sites : {};
  } catch { return {}; }
}

/** Best-effort ownership metadata must never prevent a live site from starting. */
export function rememberRuntimeStorage({ baseURL = defaultBase, storageKey, identity, storage = browserStorage() }) {
  if (!identityPattern.test(identity) || typeof storageKey !== 'string') return false;
  try {
    const key = registryKey(baseURL), sites = readRegistry(storage, key);
    sites[identity] = { storageKey };
    storage?.setItem(key, JSON.stringify({ version: 1, sites }));
    return Boolean(storage);
  } catch { return false; }
}
export function forgetRuntimeStorage({ baseURL = defaultBase, identity, storage = browserStorage() }) {
  try {
    const key = registryKey(baseURL), sites = readRegistry(storage, key);
    delete sites[identity];
    if (Object.keys(sites).length) storage?.setItem(key, JSON.stringify({ version: 1, sites }));
    else storage?.removeItem(key);
    return Boolean(storage);
  } catch { return false; }
}

/** Enumerating storage does not create a database, including when drafts were just deleted. */
export function createRuntimeStorageAdapter(indexedDB = globalThis.indexedDB, { onBlocked = () => {} } = {}) {
  const blocked = name => {
    try { Promise.resolve(onBlocked?.(name)).catch(() => {}); } catch { /* Diagnostics cannot abandon a pending deletion. */ }
  };
  const withDrafts = async (mode, operation) => {
    if (!(await indexedDB.databases()).some(item => item.name === draftDatabase)) return undefined;
    let disappeared = false;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(draftDatabase);
      request.onupgradeneeded = () => { disappeared = true; request.transaction.abort(); };
      request.onerror = () => disappeared ? resolve(null) : reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onblocked = () => blocked(draftDatabase);
    });
    if (!database) return undefined;
    try {
      if (!database.objectStoreNames.contains('sites')) return undefined;
      return await new Promise((resolve, reject) => {
        const tx = database.transaction('sites', mode), request = operation(tx.objectStore('sites'));
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error || request.error || new Error('Draft storage transaction failed.'));
        tx.onerror = () => reject(tx.error || request.error);
      });
    } finally { database.close(); }
  };
  return {
    supported: typeof indexedDB?.databases === 'function',
    async listDatabases() { return (await indexedDB.databases()).map(item => item.name).filter(Boolean); },
    async listDraftIds() { return await withDrafts('readonly', store => store.getAllKeys()) || []; },
    async removeDraft(identity) { await withDrafts('readwrite', store => store.delete(identity)); },
    removeDatabase(name) {
      return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        // A delete request cannot be cancelled. Keep the runtime lock until it
        // settles, so a delayed deletion can never erase a newly opened site.
        request.onblocked = () => blocked(name);
      });
    },
  };
}

/** Inventory only Playground runtime stores/drafts; never clear unrelated origin data. */
export function createStorageManagement({ baseURL = defaultBase, getKnownSites = () => ({}),
  getProtectedKeys = () => [], getProtectedIds = () => [], storage = browserStorage(),
  locks = globalThis.navigator?.locks, databaseStorage = createRuntimeStorageAdapter(),
} = {}) {
  const scope = new URL(baseURL).href;
  const protectedIds = async () => new Set([
    ...(await getProtectedIds() || []),
    ...await Promise.all((await getProtectedKeys() || []).filter(Boolean).map(key => runtimeStorageIdentity(scope, key))),
  ]);
  const ownership = async () => {
    const current = new Map(), foreign = new Set();
    const records = await getKnownSites() || {};
    for (const [key, value] of Object.entries(records)) {
      const storageKey = value?.storageKey || key;
      try { current.set(await runtimeStorageIdentity(scope, storageKey), { storageKey, title: value?.displayName || value?.siteName || storageKey }); } catch { /* Ignore invalid legacy preferences. */ }
    }
    const keys = new Set([registryKey(scope)]);
    try { for (let index = 0; index < (storage?.length || 0); index++) { const key = storage.key(index); if (key?.startsWith(registryPrefix)) keys.add(key); } } catch { /* A denied registry leaves explicit unassigned entries. */ }
    for (const key of keys) {
      let owner;
      try { owner = new URL(key.slice(registryPrefix.length)).href; } catch { continue; }
      for (const [id, value] of Object.entries(readRegistry(storage, key))) {
        try {
          if (!identityPattern.test(id) || await runtimeStorageIdentity(owner, value?.storageKey) !== id) continue;
          if (owner === scope) { if (!current.has(id)) current.set(id, { storageKey: value.storageKey, title: value.storageKey }); }
          else foreign.add(id);
        } catch { /* Invalid ownership metadata cannot authorize removal. */ }
      }
    }
    return { current, foreign };
  };
  const list = async () => {
    if (!databaseStorage.supported) return [];
    const [names, drafts, { current, foreign }, protectedSet] = await Promise.all([
      databaseStorage.listDatabases(), databaseStorage.listDraftIds(), ownership(), protectedIds(),
    ]);
    try {
      for (const lock of (await locks?.query?.())?.held || []) {
        if (lock.name?.startsWith('joomengine-playground:')) protectedSet.add(lock.name.slice('joomengine-playground:'.length));
      }
    } catch { /* remove() still requires an exclusive lock. */ }
    const entries = new Map();
    const entry = id => {
      if (foreign.has(id) && !current.has(id)) return null;
      if (!entries.has(id)) {
        const known = current.get(id);
        entries.set(id, { id, title: known?.title || `Unassigned Playground data (${id.slice(0, 8)})`,
          storageKey: known?.storageKey || null, scope: known ? 'current' : 'unassigned', manualOnly: !known,
          databases: [], hasDrafts: false, protected: protectedSet.has(id), removable: !protectedSet.has(id) && typeof locks?.request === 'function' });
      }
      return entries.get(id);
    };
    for (const name of names) { const match = runtimeStorePattern.exec(name); if (match) entry(match[1])?.databases.push(name); }
    for (const id of drafts) if (typeof id === 'string' && identityPattern.test(id)) { const record = entry(id); if (record) record.hasDrafts = true; }
    return [...entries.values()].sort((a, b) => a.title.localeCompare(b.title));
  };
  return {
    supported: Boolean(databaseStorage.supported),
    list,
    async remove(id, { allowUnassigned = false } = {}) {
      if (!identityPattern.test(id)) throw new TypeError('Invalid runtime storage identity.');
      if (typeof locks?.request !== 'function') throw new Error('Safe storage removal requires browser Web Locks.');
      return locks.request(`joomengine-playground:${id}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('This site is running in another tab. Stop it there before removing its storage.');
        if ((await protectedIds()).has(id)) throw new Error('The current live site cannot be removed from backup storage.');
        // Refresh after obtaining the lock: ownership/protection may have changed
        // since the panel was opened. This callback owns the only matching lock.
        const record = (await list()).find(item => item.id === id);
        if (!record) throw new Error('This Playground storage is no longer available.');
        if (record.manualOnly && !allowUnassigned) throw new Error('Unassigned Playground storage requires individual confirmation.');
        if ((await protectedIds()).has(id)) throw new Error('The current live site cannot be removed from backup storage.');
        for (const name of record.databases) await databaseStorage.removeDatabase(name);
        if (record.hasDrafts) await databaseStorage.removeDraft(id);
        if (record.scope === 'current') forgetRuntimeStorage({ baseURL: scope, identity: id, storage });
        return record;
      });
    },
  };
}
