// Automatic launch is deliberately cancellable before any runtime work starts.
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
    if (remaining === 0) {
      stop();
      void onLaunch();
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
