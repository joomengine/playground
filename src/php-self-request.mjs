import { createNetworkTransport } from './network-transport.mjs';
import { fetchHttpRedirects } from './http-redirects.mjs';
import { captureDebugFilesystem, applyDebugFilesystem } from './code/debug-runtime.mjs';
import { restoreResponse, serializeRequest } from './http.mjs';

/** Independent CGI processes must not wait on their caller's global Web Lock. */
export function configurePhpCallback(php) {
  const lockName = `joomengine-php-callback-${crypto.randomUUID()}`;
  const withLock = php._withRequestLock.bind(php);
  php._withRequestLock = (callback, name = lockName) => withLock(callback, name);
  php.cookieJar.cookies.clear();
}

/** Route a PHP HTTP callback to a second CGI process while its caller is suspended. */
export function createPhpSelfRequestFetch({ siteURL, transport, request }) {
  const site = new URL(siteURL);
  const ownSite = value => {
    const url = new URL(value instanceof Request ? value.url : String(value), site);
    return url.origin === site.origin && url.pathname.startsWith(site.pathname);
  };
  return (input, init = {}) => {
    if (!ownSite(input)) return transport(input, init);
    const callbacks = new Set();
    const execute = next => {
      const pending = request(next);
      callbacks.add(pending);
      void pending.finally(() => callbacks.delete(pending)).catch(() => {});
      return pending;
    };
    // This is delivery to our local HTTP server, so browser CORS and forbidden
    // header restrictions do not apply. All response/timeout handling still
    // passes through the ordinary shared transport.
    const local = createNetworkTransport(async (input, options) => {
      const outgoing = new Request(input, options);
      Object.defineProperty(outgoing, 'headers', { value: new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined)) });
      const result = await fetchHttpRedirects(next => ownSite(next)
        ? execute(next) : transport(next, { network: { ...init.network, redirect: 'manual' } }),
      new URL(outgoing.url), outgoing, {
        redirect: init.network?.redirect ?? outgoing.redirect,
        maxRedirects: init.network?.maxRedirects,
      });
      const response = new Response(result.response.body, result.response);
      Object.defineProperties(response, {
        url: { value: result.url, configurable: true },
        redirected: { value: result.redirected, configurable: true },
        networkRedirectCount: { value: result.redirectCount, configurable: true },
      });
      return response;
    });
    // A cancelled child must hand back its completed writes before native PHP
    // resumes. Otherwise a late filesystem delta could overwrite newer work.
    return local(input, init).finally(() => Promise.allSettled(callbacks));
  };
}

/** A child never mounts persisted storage; only its completed delta reaches the owner. */
export function createPhpRequestWorker({ options, getFilesystem, databaseCall,
  workerURL = new URL('./php-worker.mjs', import.meta.url), WorkerType = globalThis.Worker }) {
  return async request => {
    request.signal.throwIfAborted();
    const fs = getFilesystem();
    const snapshot = captureDebugFilesystem(fs);
    const serialized = await serializeRequest(request);
    request.signal.throwIfAborted();
    const worker = new WorkerType(workerURL, { type: 'module', name: 'JoomEngine PHP HTTP callback', execArgv: [] });
    const connections = new Set();
    const databaseTasks = new Set();
    const applySnapshot = entries => {
      const next = new Map(entries);
      const cookies = new Map(snapshot).get('/config/.cookies');
      if (cookies) next.set('/config/.cookies', cookies); else next.delete('/config/.cookies');
      applyDebugFilesystem(fs, snapshot, [...next]);
    };
    const callDatabase = payload => {
      const task = (async () => {
        const input = JSON.parse(payload);
        const value = await databaseCall(payload);
        const output = JSON.parse(value);
        if (output.ok && input.op === 'connect') connections.add(output.result.connection);
        if (output.ok && input.op === 'close') connections.delete(input.connection);
        return value;
      })();
      databaseTasks.add(task);
      void task.finally(() => databaseTasks.delete(task)).catch(() => {});
      return task;
    };
    try {
      return await new Promise((resolve, reject) => {
        let finished = false, abortTimer;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(abortTimer);
          request.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        };
        const abort = () => {
          worker.postMessage({ type: 'cancel-self-request' });
          // A CPU-bound extension may never yield back to its worker. Bound
          // termination just as for a stopped debugger; never replay the call.
          abortTimer = setTimeout(() => finish(request.signal.reason), 250);
        };
        request.signal.addEventListener('abort', abort, { once: true });
        worker.onerror = event => finish(new Error(event.message || 'The PHP HTTP callback failed.'));
        worker.onmessageerror = () => finish(new Error('The PHP HTTP callback returned an unreadable response.'));
        worker.onmessage = async event => {
          const message = event.data;
          if (finished) return;
          if (message?.type === 'self-request-cancelling') {
            // A responsive worker is now synchronously copying its files. A
            // large Joomla tree can take longer than the yield deadline.
            clearTimeout(abortTimer);
            abortTimer = setTimeout(() => finish(request.signal.reason), 30_000);
            return;
          }
          if (message?.type === 'self-request-cancelled') {
            try { if (message.snapshot) applySnapshot(message.snapshot); }
            catch (error) { return finish(error); }
            return finish(request.signal.reason);
          }
          if (request.signal.aborted) return;
          if (message?.type === 'database-call') {
            try {
              const value = await callDatabase(message.payload);
              if (!request.signal.aborted) worker.postMessage({ type: 'database-result', id: message.id, value });
            } catch (error) {
              if (!request.signal.aborted) worker.postMessage({ type: 'database-result', id: message.id, error: error.message });
            }
          } else if (message?.type === 'result') {
            if (message.error) {
              try { if (message.snapshot) applySnapshot(message.snapshot); }
              catch (error) { return finish(error); }
              return finish(new Error(message.error));
            }
            if (message.id === 1) {
              worker.postMessage({ type: 'operation', id: 2, operation: 'selfRequest', args: serialized });
            } else if (message.id === 2) {
              try {
                applySnapshot(message.value.snapshot);
                finish(null, restoreResponse(message.value.response, request.method));
              } catch (error) { finish(error); }
            }
          }
        };
        if (typeof worker.on === 'function') {
          worker.on('message', data => worker.onmessage({ data }));
          worker.on('error', error => worker.onerror(error));
          worker.on('messageerror', () => worker.onmessageerror());
        }
        worker.postMessage({ type: 'operation', id: 1, operation: 'initialize', args: {
          ...options, persistence: false, readOnly: false, debugger: undefined, snapshot,
        } });
        if (request.signal.aborted) abort();
      });
    } finally {
      await worker.terminate();
      await Promise.allSettled(databaseTasks);
      await Promise.allSettled([...connections].map(connection => databaseCall(JSON.stringify({ version: 1, op: 'close', connection }))));
    }
  };
}
