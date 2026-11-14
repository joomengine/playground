/** Recognise browser storage rejection without treating arbitrary write errors as quota failures. */
export function isStorageQuotaError(error) {
  const visited = new Set();
  while (error && typeof error === 'object' && !visited.has(error)) {
    visited.add(error);
    if (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED'
      || error.code === 'QuotaExceededError') return true;
    error = error.cause;
  }
  return false;
}

/** Browser estimates are advisory; failure to obtain them must never stop a save. */
export async function estimateStorage(storage = globalThis.navigator?.storage) {
  try {
    if (typeof storage?.estimate !== 'function') return null;
    const estimate = await storage.estimate();
    const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const usage = valid(estimate?.usage) ? estimate.usage : null;
    const quota = valid(estimate?.quota) ? estimate.quota : null;
    if (usage === null && quota === null) return null;
    return { usage, quota, available: usage !== null && quota !== null ? Math.max(0, quota - usage) : null };
  } catch { return null; }
}

/**
 * Retry an idempotent storage write once after releasing disposable downloads.
 * Callers retain the save reservation across both attempts, and reclaim must
 * remove ONLY replaceable maintained-image cache entries, returning { removed,
 * bytes }. Never pass a Joomla/PHP request or any other application mutation:
 * a storage retry must not execute the user's operation for a second time.
 */
export async function withStorageRecovery(write, {
  reclaim, storage = globalThis.navigator?.storage, onRecovery,
} = {}) {
  let originalError;
  try { return await write(); }
  catch (error) {
    if (!isStorageQuotaError(error) || typeof reclaim !== 'function') throw error;
    originalError = error;
  }

  const notify = details => {
    try { Promise.resolve(onRecovery?.(details)).catch(() => {}); }
    catch { /* Optional diagnostics cannot change whether a save succeeds. */ }
  };
  const before = await estimateStorage(storage);
  let reclaimed;
  try { reclaimed = await reclaim(); }
  catch (error) {
    notify({ recovered: false, retried: false, originalError, recoveryError: error, before });
    throw originalError;
  }
  if (!Number.isSafeInteger(reclaimed?.removed) || reclaimed.removed < 1) {
    notify({ recovered: false, retried: false, originalError, reclaimed, before });
    throw originalError;
  }

  const after = await estimateStorage(storage);
  try {
    const result = await write();
    notify({ recovered: true, retried: true, originalError, reclaimed, before, after });
    return result;
  } catch (error) {
    notify({ recovered: false, retried: true, originalError, error, reclaimed, before, after });
    throw error;
  }
}
