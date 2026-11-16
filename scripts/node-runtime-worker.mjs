import { parentPort, workerData } from 'node:worker_threads';
import { createNodeRuntime } from './node-runtime-local.mjs';

// Report diagnostics in the host so callers retain the console warning contract.
console.warn = (...values) => parentPort.postMessage({ type: 'diagnostic', values });
const serializeError = error => ({ name: error.name, message: error.message, code: error.code });
try {
  const runtime = await createNodeRuntime(workerData);
  const metadata = {};
  for (const key of ['url', 'baseUrl', 'assetBaseUrl', 'manifest', 'phpVersion', 'phpSettings',
    'documentRoot', 'installMarkerPath', 'runtimeInfo']) metadata[key] = runtime[key];
  metadata.mailState = runtime.mail.state;
  runtime.mail.subscribe(state => parentPort.postMessage({ type: 'mail-state', state }));
  parentPort.postMessage({ id: 0, value: metadata });
  let queue = Promise.resolve();
  parentPort.on('message', ({ id, operation, args }) => {
    if (['mail.list', 'mail.get', 'mail.clear'].includes(operation)) {
      // This lane cannot wait for the PHP operation which is capturing mail.
      void Promise.resolve().then(() => runtime.mail[operation.slice(5)](...args))
        .then(value => parentPort.postMessage({ id, value }),
          error => parentPort.postMessage({ id, error: serializeError(error) }));
      return;
    }
    queue = queue.then(async () => {
      try {
        let value;
        if (operation.startsWith('fs.') && Object.hasOwn(runtime.fs, operation.slice(3))) {
          value = await runtime.fs[operation.slice(3)](...args);
        } else if (operation === 'request') {
          const response = await runtime.request(...args);
          value = { status: response.status, statusText: response.statusText,
            headers: [...response.headers], body: new Uint8Array(await response.arrayBuffer()) };
        } else if (['runPhp', 'flush', 'close'].includes(operation)) {
          value = await runtime[operation](...args);
        } else throw new TypeError('Unknown Node runtime operation.');
        parentPort.postMessage({ id, value });
      } catch (error) { parentPort.postMessage({ id, error: serializeError(error) }); }
    });
  });
} catch (error) {
  parentPort.postMessage({ id: 0, error: serializeError(error), fatal: true });
}
