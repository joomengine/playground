import { parentPort } from 'node:worker_threads';
import { createNodeRuntime } from './node-runtime-local.mjs';
import { serializeResponse } from '../src/http.mjs';

let runtime, sequence = 0;
const pending = new Map();
const databaseCall = payload => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'database-call', id, payload });
});
parentPort.on('message', async message => {
  if (message.type === 'cancel-self-request') {
    parentPort.postMessage({ type: 'self-request-cancelling' });
    parentPort.postMessage({ type: 'self-request-cancelled', snapshot: runtime ? runtime.captureFilesystem() : null });
    return;
  }
  if (message.type === 'database-result') {
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error)); else task.resolve(message.value);
    return;
  }
  if (message.type !== 'operation') return;
  try {
    let value;
    if (message.operation === 'initialize') {
      const options = message.args;
      runtime = await createNodeRuntime({ ...options, requestContext: {
        hostCalls: { 'mariadb.v1': databaseCall }, siteURL: options.siteURL, snapshot: options.snapshot,
      } });
      value = {};
    } else if (message.operation === 'selfRequest') {
      const request = message.args;
      const response = await runtime.request(request.url, { method: request.method, headers: request.headers, body: request.body });
      value = { response: await serializeResponse(response), snapshot: runtime.captureFilesystem() };
    } else throw new TypeError('Unknown PHP HTTP callback operation.');
    parentPort.postMessage({ type: 'result', id: message.id, value });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id: message.id, error: error.message,
      ...(message.operation === 'selfRequest' && runtime ? { snapshot: runtime.captureFilesystem() } : {}) });
  }
});
