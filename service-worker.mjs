import { serializeRequest, restoreResponse } from './src/http.mjs';
import { StaticAssetCache } from './src/static-assets.mjs';
import { ISOLATION_BOOTSTRAP_VERSION, isolationMarker, isolationResponseHeaders, isOwnerClient, resolveRequestIsolation, runtimeResource } from './src/isolation.mjs';
import { createPublicAssetHandler } from './src/public-assets-worker.mjs';

const scope = new URL(self.registration.scope);
const sitePrefix = `${scope.pathname}__site/`;
const staticAssets = new StaticAssetCache();
const publicAssets = createPublicAssetHandler({ baseURL: scope.href });

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (['playground-client', 'playground-environment'].includes(event.data?.type) && event.ports[0] && event.source?.id) {
    event.ports[0].postMessage({ clientId: event.source.id, bootstrapVersion: ISOLATION_BOOTSTRAP_VERSION,
      policy: isolationMarker(event.source.url)?.policy ?? 'credentialless' });
  }
});

/** Intentional debugger pauses outlive background-tab timer throttling. */
export function waitForPlaygroundResponse({ port, ownerAlive, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, generation = 0, finished = false;
  const close = () => {
    finished = true; generation++;
    clearTimer(timer); port.close();
  };
  const promise = new Promise((resolve, reject) => {
    const wait = paused => {
      clearTimer(timer);
      const current = ++generation;
      timer = setTimer(async () => {
        if (finished || current !== generation) return;
        if (paused) {
          let alive = false;
          try { alive = await ownerAlive(); } catch { /* A lost owner cannot resume this request. */ }
          // A response/resume may arrive while the Clients lookup is pending.
          if (finished || current !== generation) return;
          if (alive) { wait(true); return; }
        }
        close();
        reject(new Error(paused ? 'The paused PHP debugger lost its owner tab.' : 'The playground did not answer the request within 600 seconds'));
      }, paused ? 15_000 : 600_000);
    };
    wait(false);
    port.onmessage = event => {
      if (finished) return;
      if (event.data?.type === 'playground-request-state') { wait(event.data.state === 'paused'); return; }
      close();
      if (event.data?.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
  });
  return { promise, close };
}

async function routeToPlayground(request) {
  const url = new URL(request.url);
  const [ownerId, instanceId] = url.pathname.slice(sitePrefix.length).split('/');
  const owner = await self.clients.get(ownerId);
  if (!isOwnerClient(owner, scope.href)) {
    return new Response('This playground is closed. Open the playground page to start the site.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const serialized = await serializeRequest(request);
  const channel = new MessageChannel();
  const waiting = waitForPlaygroundResponse({
    port: channel.port1,
    async ownerAlive() {
      const active = await self.clients.get(ownerId);
      return isOwnerClient(active, scope.href);
    },
  });
  try {
    const value = await staticAssets.respond(serialized, request => {
      owner.postMessage({ type: 'playground-request', instanceId, request }, [channel.port2]);
      return waiting.promise;
    }, { cache: request.cache });
    const response = restoreResponse(value, request.method);
    response.headers.set('Cache-Control', value.staticAsset === true ? 'private, no-cache' : 'no-store');
    return response;
  } finally {
    waiting.close();
    channel.port2.close();
  }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const local = url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
  // The only cross-origin interception is an exact registry-approved image in
  // confirmed compatibility mode. Other requests retain ordinary Fetch rules.
  if (!local && event.request.destination !== 'image') return;
  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;
  event.respondWith((async () => {
    let policy = 'credentialless';
    try {
      const isolation = await resolveRequestIsolation(event, { baseURL: scope.href, getClient: id => self.clients.get(id) });
      policy = isolation.policy;
      const compatibleImage = await publicAssets(event.request, { policy, onDiagnostic: detail => {
        if (isolation.ownerId) void self.clients.get(isolation.ownerId).then(owner => owner?.postMessage(detail));
      } });
      if (!local && !compatibleImage) return fetch(event.request);
      const resource = local ? runtimeResource(url, scope.href) : null;
      if (resource && !['GET', 'HEAD'].includes(event.request.method)) {
        return new Response('Owned runtime assets support GET and HEAD only.', { status: 405,
          headers: isolationResponseHeaders({ Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }, policy) });
      }
      const sourceURL = resource ? new URL(resource.url) : url;
      const response = compatibleImage ?? (url.pathname.startsWith(sitePrefix)
        ? await routeToPlayground(event.request)
        : await fetch(resource ? new Request(resource.url, {
          method: event.request.method, headers: event.request.headers, mode: 'same-origin',
          credentials: event.request.credentials, redirect: event.request.redirect,
          cache: event.request.cache, signal: event.request.signal,
        }) : event.request, {
          // Revalidate the shell/module graph and catalog after a release. Large
          // runtime binaries use versioned/content-hashed URLs in the manifest.
          ...(!sourceURL.pathname.startsWith(`${scope.pathname}assets/`) || sourceURL.pathname === `${scope.pathname}assets/manifest.json`
            ? { cache: event.request.cache === 'no-store' ? 'no-store' : 'no-cache' } : {}),
        }));
      if (response.type === 'opaque' || response.status === 0) return response;
      const headers = isolationResponseHeaders(response.headers, policy);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      return new Response(error.message, { status: 503, headers: isolationResponseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, policy) });
    }
  })());
});
