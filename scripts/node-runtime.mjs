import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { phpRequestTimeoutMs } from '../src/php-settings.mjs';
import { createNodeWorkerClient } from './node-runtime-client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Isolate PHP and its database so host deadlines can stop CPU-bound operations. */
export async function createNodeRuntime(options = {}) {
  const directory = path.resolve(options.directory ?? process.env.PLAYGROUND_DIST ?? path.join(root, 'dist'));
  const worker = new Worker(new URL('./node-runtime-worker.mjs', import.meta.url), {
    workerData: { ...options, directory },
  });
  const client = createNodeWorkerClient(worker);
  let metadata;
  try { metadata = await client.ready; }
  catch (error) { await client.terminate(); throw error; }
  let queue = Promise.resolve();
  let closing = false;
  let closePromise;
  const enqueue = operation => {
    if (closing) return Promise.reject(new Error('The Node playground runtime is closing.'));
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const fs = Object.fromEntries(['mkdir', 'writeFile', 'readFile', 'readdir', 'stat', 'unlink']
    .map(name => [name, (...args) => client.call(`fs.${name}`, args)]));
  const runPhp = (source, { timeoutMs = 180_000 } = {}) => client.call('runPhp', [source], timeoutMs);
  const request = async (pathname = '/', init = {}) => {
    // Request/Headers are not structured-cloneable. Normalize bodies in the host.
    const url = new URL(String(pathname).replace(/^\/+/, ''), metadata.baseUrl);
    const input = new Request(url, { ...init, redirect: 'manual' });
    const body = input.body ? new Uint8Array(await input.arrayBuffer()) : undefined;
    const result = await client.call('request', [String(pathname), {
      method: input.method, headers: [...input.headers], body,
    }], init.timeoutMs ?? phpRequestTimeoutMs(metadata.phpSettings));
    return new Response(input.method === 'HEAD' || [204, 205, 304].includes(result.status) ? null : result.body,
      { status: result.status, statusText: result.statusText, headers: result.headers });
  };
  const fetchAsset = async (value, init) => {
    const url = new URL(value instanceof Request ? value.url : value, metadata.assetBaseUrl);
    if (url.origin !== new URL(metadata.assetBaseUrl).origin) return fetch(value, init);
    const basePath = new URL(metadata.assetBaseUrl).pathname;
    if (!url.pathname.startsWith(basePath)) throw new Error('Build asset URL leaves the deployment path.');
    const filename = path.resolve(directory, decodeURIComponent(url.pathname.slice(basePath.length)));
    if (!filename.startsWith(`${directory}${path.sep}`)) throw new Error('Build asset URL leaves the distribution.');
    try { return new Response(await readFile(filename)); }
    catch (error) {
      if (error.code === 'ENOENT') return new Response('Build asset not found', { status: 404 });
      throw error;
    }
  };
  const sourceLoader = name => {
    if (!/^[a-z-]+$/.test(name)) throw new TypeError('Invalid Joomla provisioning script name.');
    return readFile(path.join(directory, 'src/joomla/php', `${name}.php`), 'utf8');
  };
  const raw = { ...metadata, fs, runPhp, request, fetchAsset, sourceLoader, flush: () => client.call('flush') };
  return {
    ...raw,
    fs: Object.fromEntries(Object.entries(fs).map(([name, operation]) => [name, (...args) => enqueue(() => operation(...args))])),
    runPhp: (...args) => enqueue(() => runPhp(...args)),
    request: (...args) => enqueue(() => request(...args)),
    flush: () => enqueue(raw.flush),
    withExclusive: callback => enqueue(() => callback(raw)),
    exportSite: options => enqueue(async () => {
      const { exportSite } = await import(pathToFileURL(path.join(directory, 'src/export.mjs')));
      return exportSite(raw, options, { sourceLoader: () => readFile(path.join(directory, 'src/export/site.php'), 'utf8') });
    }),
    close() {
      closing = true;
      return closePromise ??= (async () => {
        await queue;
        try { if (!client.failed) await client.call('close', [], 30_000); }
        finally { await client.terminate(); }
      })();
    },
  };
}
