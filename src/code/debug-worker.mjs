import { PhpDebugRuntime } from './debug-runtime.mjs';
import { createPhpFetch } from '../php-network.mjs';
import { runtimeRandomValue } from '../php-settings.mjs';

let runtime;
let running = false;
let nextDatabaseId = 0;
const databaseCalls = new Map();
const errorMessage = error => error?.message || String(error);

function databaseCall(payload) {
  const id = ++nextDatabaseId;
  return new Promise((resolve, reject) => {
    databaseCalls.set(id, { resolve, reject });
    self.postMessage({ type: 'database-call', id, payload });
  });
}

async function start(message) {
  if (running) throw new Error('The PHP debugger Worker owns one request only.');
  running = true;
  const options = message.options;
  globalThis.fetch = createPhpFetch(globalThis.fetch.bind(globalThis), options.siteURL, () => running);
  for (const field of ['moduleUrl', 'adapterUrl']) {
    const url = new URL(options[field], self.location.href);
    if (url.origin !== self.location.origin) throw new TypeError('Debugger code must be hosted with JoomEngine.');
  }
  const { createPhpWasmAdapter } = await import(options.adapterUrl);
  const adapter = createPhpWasmAdapter({ 'mariadb.v1': databaseCall });
  runtime = new PhpDebugRuntime({ ...options, adapter, runtimeOptions: { getRandomValue: runtimeRandomValue },
    onEvent: event => self.postMessage({ type: 'debug-event', ...event }) });
  for (const [path, breakpoints] of message.breakpoints || []) await runtime.setBreakpoints(path, breakpoints);
  try {
    const value = await runtime.execute(message.request, {
      started: () => self.postMessage({ type: 'debug-state', state: 'running' }),
      paused: () => self.postMessage({ type: 'debug-state', state: 'paused' }),
      resumed: () => self.postMessage({ type: 'debug-state', state: 'running' }),
    });
    self.postMessage({ type: 'debug-result', value, snapshot: runtime.snapshotEntries });
  } catch (error) {
    self.postMessage({ type: 'debug-result', error: errorMessage(error), snapshot: runtime.snapshotEntries });
  }
  // The owner applies the returned delta before resolving the original request.
  // Closing this disposable Worker releases the finished phpdbg module memory.
  self.close();
}

self.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'database-result') {
    const pending = databaseCalls.get(message.id);
    if (!pending) return;
    databaseCalls.delete(message.id);
    if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
    return;
  }
  if (message?.type === 'debug-start') {
    void start(message).catch(error => { self.postMessage({ type: 'debug-result', error: errorMessage(error) }); self.close(); });
    return;
  }
  if (message?.type === 'debug-command') {
    void Promise.resolve().then(() => {
      if (!runtime) throw new Error('PHP debugging has not started.');
      return runtime.command(message.command, message.args);
    }).then(value => self.postMessage({ type: 'debug-command-result', id: message.id, value }),
      error => self.postMessage({ type: 'debug-command-result', id: message.id, error: errorMessage(error), code: error.code }));
  }
});
