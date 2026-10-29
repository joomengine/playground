const MAX_DOCUMENTS = 128;
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

/** Keep only workspace-relative editor data; runtime state and credentials never enter recovery. */
export function validateDrafts(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.documents) || value.documents.length > MAX_DOCUMENTS) {
    throw new Error('The saved JoomEngine Code draft record is not supported.');
  }
  let size = 0;
  const paths = new Set();
  for (const document of value.documents) {
    if (typeof document.path !== 'string' || !document.path.startsWith('/') || /[\0\\]/.test(document.path)
      || document.path.split('/').some(part => part === '.' || part === '..') || paths.has(document.path)) {
      throw new Error('The saved JoomEngine Code draft has an invalid file path.');
    }
    paths.add(document.path);
    if (document.text !== undefined && typeof document.text !== 'string') throw new Error('Invalid recovered draft contents.');
    if (document.revision !== undefined && typeof document.revision !== 'string') throw new Error('Invalid recovered draft revision.');
    size += encoder.encode(document.text || '').byteLength;
  }
  if (size > MAX_DRAFT_BYTES) throw new Error('JoomEngine Code drafts exceed the 8 MiB recovery limit. Save or download large drafts before closing this tab.');
  return value;
}

/** IndexedDB recovery is separate from the Joomla filesystem and scoped to its persisted identity. */
async function openDraftStore(storageId) {
  if (typeof storageId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(storageId)) throw new TypeError('Invalid draft storage identity.');
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('joomengine-code-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sites');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Another tab is blocking JoomEngine Code recovery storage.'));
  });
  const transaction = (mode, operation) => new Promise((resolve, reject) => {
    const tx = database.transaction('sites', mode);
    const request = operation(tx.objectStore('sites'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || request.error || new Error('Draft storage transaction failed.'));
    tx.onerror = () => reject(tx.error || request.error);
  });
  return {
    read: () => transaction('readonly', store => store.get(storageId)),
    write: value => transaction('readwrite', store => store.put(validateDrafts(value), storageId)),
    clear: () => transaction('readwrite', store => store.delete(storageId)),
    close: () => database.close(),
  };
}

/** Bind recovery to the existing workbench models; never create a second editor session. */
export async function attachEditorRecovery({ storageId, workspace, provider, models, editors, api, onError }) {
  if (!storageId) return { dispose: async () => {} };
  const store = await openDraftStore(storageId);
  let timer, disposed = false, erased = false, pending = Promise.resolve();
  const listeners = new Map();
  const unresolved = new Map();
  const snapshot = () => {
    const documents = api.getOpenFiles().map(file => ({ path: file.path,
      ...(file.dirty ? { text: file.text, revision: provider.revisions.get(file.path) } : {}) }));
    const present = new Set(documents.map(document => document.path));
    for (const [path, value] of unresolved) if (!present.has(path)) documents.push(value);
    return validateDrafts({ version: 1, documents, activePath: editors.activeEditor?.resource?.path });
  };
  const flush = () => {
    clearTimeout(timer);
    if (disposed || erased) return pending;
    let value;
    try { value = snapshot(); } catch (error) { onError(error); return pending; }
    pending = pending.catch(() => {}).then(() => store.write(value));
    pending.catch(error => onError(new Error(`JoomEngine Code could not preserve drafts: ${error.message}. Keep this tab open and save or download the affected files.`)));
    return pending;
  };
  const schedule = () => { clearTimeout(timer); if (!disposed && !erased) timer = setTimeout(flush, 150); };
  const watch = model => {
    if (model.uri.scheme !== 'jec' || model.uri.authority !== provider.siteId) return;
    listeners.set(model, model.onDidChangeContent(schedule));
  };
  try {
    const saved = await store.read();
    if (saved) {
      validateDrafts(saved);
      for (const draft of saved.documents) {
        try {
          await api.openFile(draft.path);
          const model = models.getModel(provider.uri(draft.path));
          if (!model) throw new Error('The file cannot be opened as text.');
          if (typeof draft.text === 'string' && draft.text !== model.getValue()) {
            model.pushEditOperations([], [{ range: model.getFullModelRange(), text: draft.text }], () => null);
            if (draft.revision) provider.revisions.set(draft.path, draft.revision);
          }
        } catch (error) {
          if (typeof draft.text === 'string') {
            unresolved.set(draft.path, draft);
            onError(new Error(`Draft for ${draft.path} is preserved, but the file could not be reopened: ${error.message}. Use “Recover missing drafts” in the command palette.`));
          }
        }
      }
      if (saved.activePath && models.getModel(provider.uri(saved.activePath))) await api.openFile(saved.activePath);
    }
  } catch (error) { onError(error); }
  models.getModels().forEach(watch);
  const subscriptions = [
    models.onModelAdded(watch),
    models.onModelRemoved(model => { listeners.get(model)?.dispose(); listeners.delete(model); schedule(); }),
    editors.onDidEditorsChange(schedule),
    editors.onDidActiveEditorChange(schedule),
  ];
  const unsubscribe = workspace.subscribe?.(event => {
    if (event.type === 'workspace-closed' && event.erased) {
      erased = true; clearTimeout(timer);
      pending = pending.catch(() => {}).then(() => store.clear());
      pending.catch(onError);
    }
  });
  const visibility = () => { if (document.visibilityState === 'hidden') void flush(); };
  const hide = () => { void flush(); };
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', hide);
  return {
    flush,
    async recoverMissing() {
      for (const [path, draft] of [...unresolved]) {
        await editors.openEditor({ resource: provider.uri(path), forceUntitled: true, contents: draft.text,
          options: { pinned: true } });
        // Keep the durable record until this recovered tab has been explicitly
        // saved at its intended path; closing a new untitled tab is not a write.
      }
    },
    async dispose() {
      if (disposed) return;
      await flush().catch(() => {});
      disposed = true;
      clearTimeout(timer);
      subscriptions.forEach(subscription => subscription.dispose());
      listeners.forEach(subscription => subscription.dispose());
      if (typeof unsubscribe === 'function') unsubscribe(); else unsubscribe?.dispose();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      store.close();
    },
  };
}
