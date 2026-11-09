/** Keep launch feedback independent of the deployment's internal progress phases. */
export function createLaunchMedia({ video, poster, document = globalThis.document,
  motion = globalThis.matchMedia('(prefers-reduced-motion: reduce)') }) {
  let active = false;
  let requested = false;
  let generation = 0;
  let disposed = false;

  function stop() {
    generation += 1;
    requested = false;
    video.pause();
    video.hidden = true;
    poster.hidden = false;
  }

  function synchronize() {
    if (!active || document.hidden || motion.matches) { stop(); return; }
    if (requested) return;
    requested = true;
    const attempt = ++generation;
    video.hidden = false;
    poster.hidden = true;
    // Muted inline playback also supports the automatic countdown path. A
    // rejected or superseded play request must leave a usable poster behind.
    const failed = () => { if (attempt === generation) stop(); };
    try { Promise.resolve(video.play()).catch(failed); }
    catch { failed(); }
  }

  document.addEventListener('visibilitychange', synchronize);
  motion.addEventListener('change', synchronize);
  return {
    setActive(value) {
      if (disposed) return;
      active = Boolean(value);
      synchronize();
    },
    dispose() {
      disposed = true;
      active = false;
      document.removeEventListener('visibilitychange', synchronize);
      motion.removeEventListener('change', synchronize);
      stop();
    },
  };
}
