import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationResponseHeaders } from '../src/isolation.mjs';

const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const hostname = process.env.HOST || '127.0.0.1';
// Match GitHub Pages by default: only the controlling SW supplies isolation.
// Explicit overrides exercise hosts that set policy headers themselves.
const policy = process.env.PLAYGROUND_COEP || 'none';
if (!['none', 'credentialless', 'require-corp'].includes(policy)) throw new Error('PLAYGROUND_COEP must be none, credentialless or require-corp');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.so': 'application/wasm', '.zip': 'application/zip', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  // The shared routing worker does not use shared memory. Giving that worker a
  // require-corp policy would also restrict its ordinary opaque Fetch forwarding
  // for credentialless tabs. GitHub Pages likewise serves its script without COEP.
  const serviceWorkerScript = new URL(request.url, 'http://localhost').pathname === '/service-worker.mjs';
  if (policy !== 'none' && !serviceWorkerScript) {
    for (const [name, value] of isolationResponseHeaders({}, policy)) response.setHeader(name, value);
  }
  response.setHeader('Service-Worker-Allowed', '/');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes('\\') || pathname.includes('\0')) throw new Error('Invalid path');
    let filename = path.resolve(root, `.${pathname}`);
    if (filename !== root && !filename.startsWith(`${root}${path.sep}`)) throw new Error('Invalid path');
    let info = await stat(filename);
    if (info.isDirectory()) { filename = path.join(filename, 'index.html'); info = await stat(filename); }
    if (!info.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filename).pipe(response);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error.code === 'ENOENT' ? 'Not found. Run npm run build first.' : 'Invalid request');
  }
});
server.listen(port, hostname, () => console.log(`Playground: http://${hostname}:${server.address().port}/ (host COEP: ${policy}; service-worker bootstrap enabled)`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
