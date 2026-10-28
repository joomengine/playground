import { serializeRequest, restoreResponse } from './src/http.mjs';

const scope = new URL(self.registration.scope);
const sitePrefix = `${scope.pathname}__site/`;
const isolationHeaders = headers => {
  const result = new Headers(headers);
  result.set('Cross-Origin-Opener-Policy', 'same-origin');
  // Keep MariaDB's shared memory available without requiring public image,
  // classic script and stylesheet hosts to opt into our document's policy.
  // Cross-origin no-cors requests omit credentials; CORS requests retain CORS.
  result.set('Cross-Origin-Embedder-Policy', 'credentialless');
  result.set('Cross-Origin-Resource-Policy', 'same-origin');
  return result;
};

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type === 'playground-client' && event.ports[0] && event.source?.id) {
    event.ports[0].postMessage({ clientId: event.source.id });
  }
});

async function routeToPlayground(request) {
  const url = new URL(request.url);
  const [ownerId, instanceId] = url.pathname.slice(sitePrefix.length).split('/');
  const owner = await self.clients.get(ownerId);
  if (!owner || !new URL(owner.url).pathname.startsWith(scope.pathname)) {
    return new Response('This playground is closed. Open the playground page to start the site.', { status: 503 });
  }
  const serialized = await serializeRequest(request);
  const channel = new MessageChannel();
  let timer;
  const result = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('The playground did not answer the request within 600 seconds'));
    }, 600_000);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      channel.port1.close();
      if (event.data?.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
  });
  try {
    owner.postMessage({ type: 'playground-request', instanceId, request: serialized }, [channel.port2]);
    return restoreResponse(await result, request.method);
  } finally {
    clearTimeout(timer);
    channel.port1.close();
    channel.port2.close();
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  event.respondWith((async () => {
    try {
      const response = url.pathname.startsWith(sitePrefix)
        ? await routeToPlayground(event.request)
        : await fetch(event.request);
      if (response.type === 'opaque' || response.status === 0) return response;
      const headers = isolationHeaders(response.headers);
      if (url.pathname.startsWith(sitePrefix)) headers.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return new Response(error.message, { status: 503, headers: isolationHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }) });
    }
  })());
});
