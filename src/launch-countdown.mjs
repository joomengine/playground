// Automatic launch is deliberately cancellable before any runtime work starts.
export function createLaunchCountdown({ seconds = 10, onTick, onLaunch, schedule = setTimeout, cancel = clearTimeout }) {
  let remaining = seconds;
  let timer;
  let active = false;
  function stop() {
    active = false;
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  function tick() {
    if (!active) return;
    onTick(remaining);
    if (remaining === 0) {
      stop();
      void onLaunch();
    } else {
      remaining -= 1;
      timer = schedule(tick, 1000);
    }
  }
  return {
    start() { stop(); remaining = seconds; active = true; tick(); },
    stop,
    get active() { return active; },
  };
}

export function deploymentNeedsReview(input) {
  return Boolean(input.extensions?.length || input.startupCommands?.length || input.template?.url
    || input.languages?.some(language => language.url));
}
