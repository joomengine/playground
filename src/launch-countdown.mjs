/**
 * Automatic launch remains cancellable before runtime work starts. After the
 * zero tick, a 100 ms final stage gives the UI time to paint; `active` stays true
 * during that stage so Stop, disposal and restarted countdowns can cancel it.
 */
export function createLaunchCountdown({ seconds = 10, onTick, onLaunch, schedule = setTimeout, cancel = clearTimeout }) {
  let remaining = seconds;
  let timer;
  let active = false;
  let generation = 0;
  function stop() {
    active = false;
    generation += 1;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  function tick(epoch) {
    if (!active || epoch !== generation) return;
    onTick(remaining);
    // A tick observer may itself stop or restart the countdown.
    if (!active || epoch !== generation) return;
    if (remaining === 0) {
      timer = schedule(() => {
        if (!active || epoch !== generation) return;
        stop();
        void onLaunch();
      }, 100);
    } else {
      remaining -= 1;
      timer = schedule(() => tick(epoch), 1000);
    }
  }
  return {
    start() { stop(); remaining = seconds; active = true; tick(generation); },
    stop,
    get active() { return active; },
  };
}

export function deploymentNeedsReview(input) {
  return Boolean(input.extensions?.length || input.startupCommands?.length || input.template?.url
    || input.languages?.some(language => language.url) || input.content
    || input.menus?.length || Object.keys(input.template?.params || {}).length);
}
