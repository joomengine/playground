import english from '../locales/en.mjs';

/**
 * Saving changes files; refreshing changes only the displayed Joomla page.
 * This controller deliberately knows nothing about editor buffers or PHP restarts.
 */
export function createRefreshController({
  refresh,
  onState = () => {},
  onError = () => {},
  debounceMs = 200,
  t = key => english[key] ?? key,
  setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimer = globalThis.clearTimeout.bind(globalThis),
} = {}) {
  if (typeof refresh !== 'function') throw new TypeError('A preview refresh callback is required.');
  if (!Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 10_000) throw new RangeError('Invalid preview refresh delay.');
  let automatic = false, paused = false, disposed = false, timer = null;
  let savedRevision = 0, refreshedRevision = 0, refreshing = null, automaticBlocked = false;
  const saves = new Set(), listeners = new Set([onState]);
  const state = () => Object.freeze({
    automatic, paused, saving: saves.size, refreshing: refreshing !== null,
    savedChanges: savedRevision !== refreshedRevision,
    savedRevision, refreshedRevision,
  });
  const emit = () => { const value = state(); for (const listener of listeners) { try { listener(value); } catch { /* A status label cannot fail a file save. */ } } };
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const assertActive = () => { if (disposed) throw new Error('This JoomEngine Code preview controller is closed.'); };

  function schedule() {
    cancelTimer();
    if (!automatic || automaticBlocked || paused || saves.size || refreshing || savedRevision === refreshedRevision || disposed) return;
    timer = setTimer(() => {
      timer = null;
      void refreshSite({ automatic: true }).catch(error => { try { onError(error); } catch { /* Keep editing available. */ } });
    }, debounceMs);
  }

  async function waitForSaves() {
    // Saves added while waiting belong to this refresh as well. Never initiate a save.
    while (saves.size) {
      const results = await Promise.allSettled([...saves]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }

  function markSaved({ automatic: allowAutomatic = true } = {}) {
    assertActive();
    savedRevision++;
    automaticBlocked = !allowAutomatic;
    emit();
    schedule();
  }

  function trackSave(promise, { changed = true } = {}) {
    assertActive();
    cancelTimer();
    if (!saves.size) automaticBlocked = false;
    // Register before observing the promise so a synchronous manual refresh waits.
    let tracked;
    tracked = Promise.resolve(promise).then(value => {
      if (!disposed && (typeof changed === 'function' ? changed(value) : changed)) savedRevision++;
      return value;
    }).catch(error => {
      // Failed batches never cause an automatic refresh. Call markSaved separately
      // with { automatic: false } when reporting a partially applied result.
      cancelTimer();
      automaticBlocked = true;
      throw error;
    }).finally(() => {
      saves.delete(tracked);
      if (!disposed) emit();
    });
    saves.add(tracked);
    emit();
    // The fulfilled observer schedules only after the whole tracked batch settles.
    void tracked.then(() => schedule(), () => {});
    return tracked;
  }

  function refreshSite({ automatic: fromAutomatic = false } = {}) {
    assertActive();
    if (paused) return Promise.reject(new Error(t('code.pausedRefresh')));
    if (fromAutomatic && (!automatic || savedRevision === refreshedRevision)) return Promise.resolve(false);
    if (refreshing) return refreshing;
    cancelTimer();
    let succeeded = false;
    const run = async () => {
      await waitForSaves();
      assertActive();
      if (paused) throw new Error(t('code.pausedRefresh'));
      if (fromAutomatic && !automatic) return false;
      const revision = savedRevision;
      // The callback must reload the current preview URL, never the owner document.
      await refresh();
      refreshedRevision = revision;
      automaticBlocked = false;
      succeeded = true;
      return true;
    };
    refreshing = run().finally(() => {
      refreshing = null;
      if (!disposed) { emit(); if (succeeded) schedule(); }
    });
    emit();
    return refreshing;
  }

  return {
    get state() { return state(); },
    trackSave,
    markSaved,
    waitForSaves,
    refresh: refreshSite,
    setAutomatic(value) { assertActive(); automatic = Boolean(value); emit(); schedule(); },
    setPaused(value) { assertActive(); paused = Boolean(value); emit(); schedule(); },
    subscribe(listener) {
      assertActive();
      if (typeof listener !== 'function') throw new TypeError('A preview status listener is required.');
      listeners.add(listener); listener(state());
      return () => listeners.delete(listener);
    },
    dispose() { disposed = true; cancelTimer(); listeners.clear(); },
  };
}
