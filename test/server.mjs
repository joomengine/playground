import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
};

/** Follow the same bounded controlled navigations as the real application shell. */
export async function prepareBrowserEnvironment(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const environment = await page.evaluate(async () => {
      const { prepareEnvironment } = await import('./src/playground.mjs');
      return prepareEnvironment();
    });
    if (!environment.reloadRequired) return environment;
    if (attempt === 2) throw new Error('Browser environment startup exceeded its two controlled navigations.');
    await page.goto(environment.reloadURL);
  }
}

/** Serve the built artifact exactly as static hosting would, beneath a project path. */
export async function createStaticServer({ directory, prefix = '/playground/', isolation = true, fixtures = {}, corsOrigin, corsPaths } = {}) {
  if (!prefix.startsWith('/') || !prefix.endsWith('/') || prefix.includes('..')) {
    throw new TypeError('A static test prefix must start and end with a slash.');
  }
  const root = path.resolve(directory);
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (isolation) {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    }
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith(prefix) || pathname.includes('\0') || pathname.includes('\\')) {
        response.writeHead(404).end('Not found');
        return;
      }
      const relative = pathname.slice(prefix.length);
      const allowCORS = corsOrigin && (!corsPaths || corsPaths.includes(relative));
      if (allowCORS) {
        response.setHeader('Access-Control-Allow-Origin', corsOrigin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Playground-Proof');
        response.setHeader('Vary', 'Origin');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(allowCORS ? 204 : 403).end();
        return;
      }
      if (Object.hasOwn(fixtures, relative)) {
        response.setHeader('Content-Type', contentTypes[path.extname(relative)] || 'application/octet-stream');
        response.end(typeof fixtures[relative] === 'function' ? await fixtures[relative](request) : fixtures[relative]);
        return;
      }
      if (relative === '__test__.html') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Playground integration</title><body><main id="fixture">Browser integration</main></body></html>');
        return;
      }
      const filename = path.resolve(root, relative || 'index.html');
      if (!filename.startsWith(`${root}${path.sep}`) || !(await stat(filename)).isFile()) {
        response.writeHead(404).end('Not found');
        return;
      }
      response.setHeader('Content-Type', contentTypes[path.extname(filename)] || 'application/octet-stream');
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(filename);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}${prefix}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
