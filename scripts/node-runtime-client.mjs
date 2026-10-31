/** Host-side deadlines remain live even when a PHP worker blocks in WebAssembly. */
export function createNodeWorkerClient(worker) {
  let sequence = 0;
  let failure;
  let termination;
  let queue = Promise.resolve();
  const pending = new Map();
  const stop = error => {
    failure ??= error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
    termination ??= worker.terminate();
  };
  const dispatch = (id, operation, args, timeoutMs) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 600_000) {
      reject(new RangeError('Timeout must be between 10 and 600000 milliseconds.')); return;
    }
    const timer = setTimeout(() => {
      const error = new Error(`PHP ${operation} timed out after ${timeoutMs} ms. Restart the playground; the operation was not replayed.`);
      error.code = 'TIMEOUT';
      stop(error);
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (operation !== 'initialize') {
      try { worker.postMessage({ id, operation, args }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    }
  });
  worker.on('message', message => {
    if (message.type === 'diagnostic') { console.warn(...message.values); return; }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) {
      const error = Object.assign(new Error(message.error.message), { name: message.error.name, code: message.error.code });
      if (message.fatal) stop(error);
      request.reject(error);
    } else request.resolve(message.value);
  });
  worker.on('error', stop);
  worker.on('exit', code => {
    if (!termination) stop(new Error(`The Node PHP worker exited unexpectedly (${code}).`));
  });
  return {
    ready: dispatch(0, 'initialize', [], 180_000),
    call(operation, args = [], timeoutMs = 180_000) {
      // Exclusive callbacks may use Promise.all on the raw handle. Keep the
      // deadline out of both public and raw queues until this work is sent.
      const result = queue.then(() => dispatch(++sequence, operation, args, timeoutMs));
      queue = result.catch(() => {});
      return result;
    },
    async terminate() {
      stop(new Error('The Node playground runtime is closed.'));
      await termination;
    },
    get failed() { return failure; },
  };
}
