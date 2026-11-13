/** Flush the existing dirty journal; a failed write remains available for a later retry. */
export async function flushPhpFilesystem(fs) {
  const sync = () => new Promise((resolve, reject) => {
    fs.syncfs(false, error => error ? reject(error) : resolve());
  });
  try { await sync(); }
  catch (error) {
    // IDBFS caches connections without observing an unexpected browser close.
    // Reopen only those handles, retaining the mounted files and dirty journal.
    // Quota failures require a later user retry, not another identical write.
    const closed = error?.name === 'InvalidStateError'
      || /(?:database|connection).*(?:closing|closed)/i.test(error?.message || '');
    if (!closed || !fs.root?.mount || typeof fs.getMounts !== 'function') throw error;
    let reopened = false;
    for (const mount of fs.getMounts(fs.root.mount)) {
      const backend = mount.type;
      if (backend?.DB_STORE_NAME !== 'FILE_DATA') continue;
      const database = backend.dbs?.[mount.mountpoint];
      if (!database) continue;
      try { database.close(); } catch { /* It may already be closed. */ }
      delete backend.dbs[mount.mountpoint];
      reopened = true;
    }
    if (!reopened) throw error;
    await sync();
  }
}
