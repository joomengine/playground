/** Save only between runtime operations, with one timer after each completed save. */
export function startAutosave({ canSave, save, onError = () => {}, intervalMs = 60_000, retryMs = 5_000,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = false, running = false, timer;
  const schedule = delay => { if (!stopped) timer = setTimer(tick, delay); };
  async function tick() {
    if (stopped) return;
    if (!canSave()) { schedule(retryMs); return; }
    running = true;
    try { await save(); }
    catch (error) { onError(error); }
    finally { running = false; schedule(intervalMs); }
  }
  schedule(intervalMs);
  return {
    request() { if (!stopped && !running) { clearTimer(timer); schedule(1_000); } },
    saved() { if (!stopped && !running) { clearTimer(timer); schedule(intervalMs); } },
    stop() { stopped = true; clearTimer(timer); },
  };
}
