/** A timed-out initializer has terminated its worker and released its persistence lock.
 * Reopen the same storage once, before exposing a database to PHP or importing site data.
 */
export async function initializeSiteDatabase(bridge, options, onRetry) {
  try { return await bridge.createMariaDB(options); }
  catch (cause) {
    if (!(cause instanceof bridge.MariaDBBridgeError) || cause.code !== 'TIMEOUT') throw cause;
    onRetry?.();
    return bridge.createMariaDB(options);
  }
}

/** A failed saved database must not prevent access to its separately stored files. */
export async function openSiteDatabase(open, { recovery = false, persistent = false } = {}) {
  try { return { database: await open(), error: null }; }
  catch (cause) {
    if (!persistent) throw cause;
    const details = cause instanceof Error ? cause.message : String(cause);
    const error = new Error(`The saved database could not start. Your site has not been reset. Open recovery to download its files, or retry. Database details: ${details}`, { cause });
    error.code = 'SAVED_DATABASE_START_FAILED';
    if (!recovery) throw error;
    return { database: null, error };
  }
}
