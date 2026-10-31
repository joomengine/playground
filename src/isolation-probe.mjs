// Exercise dedicated module workers, nested workers and shared WASM memory before
// PHP or MariaDB is created. This probe never opens site storage.
self.onmessage = async ({ data }) => {
  let child, timer;
  try {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw new Error('The module worker is not cross-origin isolated.');
    if (!(data.memory instanceof WebAssembly.Memory) || !(data.memory.buffer instanceof SharedArrayBuffer)) throw new Error('Shared WebAssembly memory could not be cloned into the worker.');
    const values = new Int32Array(data.memory.buffer);
    Atomics.add(values, 0, 1);
    if (!data.leaf) {
      child = new Worker(new URL('./isolation-probe.mjs', import.meta.url), { type: 'module', name: 'joomengine-isolation-nested-probe' });
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('The nested shared-memory worker did not respond.')), 8000);
        child.onmessage = event => event.data?.ok ? resolve() : reject(new Error(event.data?.error || 'Nested worker capability verification failed.'));
        child.onerror = event => reject(new Error(event.message || 'Nested module workers are blocked.'));
        child.onmessageerror = () => reject(new Error('Nested workers cannot exchange shared memory.'));
        child.postMessage({ memory: data.memory, leaf: true });
      });
    }
    self.postMessage({ ok: true, isolated: self.crossOriginIsolated, value: Atomics.load(values, 0) });
  } catch (error) { self.postMessage({ ok: false, error: error.message }); }
  finally { clearTimeout(timer); child?.terminate(); }
};
