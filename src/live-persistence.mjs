/** Persist completed live work promptly without replaying it or flooding a failed store. */
export function createLivePersistence({ save, isDirty, canSave = () => true, onError = () => {},
  delayMs = 100, retryMs = 5_000, maxRetryMs = 60_000,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let enabled = false, timer = null, running = false, disposed = false, failures = 0;
  const cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = delay => {
    if (!enabled || disposed || running || timer !== null || !isDirty()) return;
    timer = setTimer(tick, delay);
  };
  async function tick() {
    timer = null;
    if (!enabled || disposed || !isDirty()) return;
    if (!canSave()) { schedule(retryMs); return; }
    running = true;
    try { await save(); failures = 0; }
    catch (error) {
      failures++;
      try { onError(error); } catch { /* Diagnostics cannot stop the next retry. */ }
    } finally {
      running = false;
      schedule(failures ? Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures - 1, 10)) : delayMs);
    }
  }
  return {
    enable() { enabled = true; schedule(delayMs); },
    changed() { schedule(failures ? Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures - 1, 10)) : delayMs); },
    saved() { failures = 0; if (!isDirty()) cancel(); else schedule(delayMs); },
    dispose() { disposed = true; enabled = false; cancel(); },
  };
}
