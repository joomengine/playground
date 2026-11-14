import { normalizeInitialPath, resolveSiteURL } from './config.mjs';
import { serializeRequest, restoreResponse } from './http.mjs';

/** Keep SDK work out of a checkpoint/restart while its private provisioning proceeds. */
export function createRuntimeAccess({ send, siteUrl, requestTimeout, isChanging, isClosing, requireDatabase }) {
  const lane = internal => {
    const check = () => {
      if (isClosing()) throw new Error('This playground is closing.');
      if (!internal && isChanging()) throw new Error('Wait for the current site operation before accessing the runtime.');
    };
    return {
      fs: Object.fromEntries(['mkdir', 'readFile', 'writeFile', 'readdir', 'stat', 'unlink'].map(method => [method,
        async (path, data) => { check(); return send(`fs.${method}`, { path, data }); }])),
      async runPhp(source, options = {}) {
        check();
        return send('runPhp', { source }, options.timeoutMs ?? 180_000);
      },
      async request(path = '/', init = {}) {
        check(); requireDatabase();
        const target = normalizeInitialPath(`/${String(path).replace(/^\/+/, '')}`);
        const request = new Request(resolveSiteURL(target, siteUrl), init);
        const serialized = await serializeRequest(request);
        // Reading a streamed request body yields. A transition may have begun
        // since the caller entered; never dispatch its old-site write afterward.
        check();
        return restoreResponse(await send('request', serialized, init.timeoutMs ?? requestTimeout()), request.method);
      },
    };
  };
  return { public: lane(false), internal: lane(true) };
}
