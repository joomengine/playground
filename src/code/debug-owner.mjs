import { createDebugRequestMatcher } from './debug-request.mjs';
import { captureDebugFilesystem, applyDebugFilesystem } from './debug-runtime.mjs';

/** Resolve the same Joomla front controller and PATH_INFO used by the CGI owner. */
export function resolveDebugScript(php, fs, request) {
  const url = new URL(request.url);
  const rewritten = php.rewrite(url.pathname);
  const explicit = rewritten && typeof rewritten === 'object';
  const relative = explicit ? rewritten.path : String(rewritten).slice(php.prefix.length);
  if (relative.split('/').some(part => part === '..' || part === '.') || /[\\\0]/.test(relative)) throw new TypeError('Invalid PHP debug request path.');
  let filename = `${php.docroot.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
  let info = fs.analyzePath(filename);
  if (info.exists && fs.isDir(info.object.mode)) {
    filename = `${filename.replace(/\/+$/, '')}/index.php`;
    info = fs.analyzePath(filename);
  }
  if (!filename.endsWith('.php')) {
    if (info.exists && fs.isFile(info.object.mode)) throw new Error('The selected request serves a static file. Select a Joomla PHP request to debug.');
    filename = `${php.docroot}/index.php`;
    info = fs.analyzePath(filename);
  }
  if (!info.exists || !fs.isFile(info.object.mode)) throw new Error('The selected PHP request has no executable source file.');
  return { filename, pathInfo: php.env.PATH_INFO || '' };
}

/** A disposable debugger worker owns only the selected request, never storage. */
export function createPhpDebugOwner({ options, getPhp, getBinary, databaseCall, onState, onEvent, flush }) {
  const breakpoints = new Map();
  const pending = new Map();
  let selection, worker, requestReject, requestDone, sequence = 0, stopping, startupTimer;
  const siteURL = options.siteURL;
  const emit = (event, body = {}) => onEvent({ event, body });
  function cleanup() {
    clearTimeout(startupTimer);
    worker?.terminate(); worker = undefined; stopping = undefined;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('The PHP debug request ended.')); }
    pending.clear(); requestReject = undefined;
    onState('idle');
  }
  async function execute(request) {
    const php = getPhp(), fs = getBinary().FS;
    const route = resolveDebugScript(php, fs, request);
    const snapshot = captureDebugFilesystem(fs);
    worker = new Worker(new URL('./debug-worker.mjs', import.meta.url), { type: 'module', name: 'JoomEngine Code PHP debugger' });
    const activeWorker = worker;
    onState('starting');
    requestDone = new Promise((resolve, reject) => {
      requestReject = reject;
      startupTimer = setTimeout(() => reject(new Error('PHP debugger startup timed out. The request was not replayed.')), 60_000);
      worker.onerror = event => reject(new Error(event.message || 'The PHP debugger worker failed. The request was not replayed.'));
      worker.onmessageerror = () => reject(new Error('The PHP debugger returned an unreadable result.'));
      worker.onmessage = async event => {
        const message = event.data;
        if (worker !== activeWorker) return;
        if (message?.type === 'database-call') {
          try {
            const value = await databaseCall(message.payload);
            if (worker === activeWorker) activeWorker.postMessage({ type: 'database-result', id: message.id, value });
          } catch (error) {
            if (worker === activeWorker) activeWorker.postMessage({ type: 'database-result', id: message.id, error: error.message });
          }
        } else if (message?.type === 'debug-state') {
          clearTimeout(startupTimer); onState(message.state);
        } else if (message?.type === 'debug-event') {
          onEvent({ event: message.event, body: message.body });
        } else if (message?.type === 'debug-command-result') {
          const task = pending.get(message.id);
          if (!task) return;
          clearTimeout(task.timer); pending.delete(message.id);
          if (message.error) task.reject(new Error(message.error)); else task.resolve(message.value);
        } else if (message?.type === 'debug-result') {
          try {
            if (message.snapshot) applyDebugFilesystem(fs, snapshot, message.snapshot);
            for (const [name, value] of message.value?.headers || []) {
              if (name.toLowerCase() === 'set-cookie') php.cookieJar.store(value);
            }
            fs.writeFile('/config/.cookies', php.cookieJar.dump());
            await flush();
            if (message.error) reject(new Error(message.error)); else resolve(message.value);
          } catch (error) { reject(error); }
        }
      };
      worker.postMessage({ type: 'debug-start', options: { ...options, ...route, snapshot, cookieHeader: php.cookieJar.toEnv() },
        request, breakpoints: [...breakpoints] });
    });
    try { return await requestDone; }
    finally { cleanup(); }
  }
  function send(command, args = {}) {
    if (!worker) return Promise.reject(new Error('A matching Joomla request has not started under the debugger.'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`PHP debugger ${command} timed out.`)); }, 15_000);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: 'debug-command', id, command, args });
    });
  }
  return {
    arm(config) {
      if (worker) throw new Error('Stop or finish the current debug request before arming another.');
      selection = createDebugRequestMatcher({ ...config, siteURL });
      onState('armed');
      return { armed: true };
    },
    async maybeRequest(request) {
      if (!selection?.(request)) return null;
      selection = undefined; // Once-only selection, including failed and stopped POSTs.
      try { return { response: await execute(request) }; }
      catch (error) { onState('idle'); emit('terminated'); throw error; }
    },
    async command(command, args = {}) {
      if (command === 'setBreakpoints') {
        if (typeof args.path !== 'string' || !args.path.startsWith('/persist/www/') || /[\\\r\n\0]/.test(args.path)
          || args.path.split('/').some(part => part === '.' || part === '..') || !Array.isArray(args.breakpoints)) throw new TypeError('Breakpoints must target the active workspace.');
        breakpoints.set(args.path, args.breakpoints);
        if (worker) return send(command, args);
        return args.breakpoints.map(point => ({ line: point.line, verified: false, source: { path: args.path }, message: 'Waiting for the selected Joomla request.' }));
      }
      if (command === 'stop') {
        selection = undefined;
        if (!worker) { onState('idle'); emit('terminated'); return; }
        return stopping ??= (async () => {
          // Stop bypasses the request queue. Bound recovery even if native PHP is
          // stuck in an extension that cannot reach its cooperative yield hook.
          const timeout = setTimeout(() => requestReject?.(new Error('The PHP debugger was terminated after stop timed out. Its last confirmed filesystem remains active; completed database writes remain. The request was not replayed.')), 10_000);
          try {
            void send('stop').catch(() => {});
            await requestDone.catch(() => {});
          } finally { clearTimeout(timeout); }
        })();
      }
      return send(command, args);
    },
    dispose() { selection = undefined; requestReject?.(new Error('The Joomla site closed. The debug request was not replayed.')); cleanup(); },
  };
}
