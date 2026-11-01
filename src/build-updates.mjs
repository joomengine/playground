const BUILD_ID = /^[a-f0-9]{64}$/;

/** Check on startup/focus/launch, without reloading or touching any saved-site storage. */
export function createBuildUpdateMonitor({ baseURL, loadedId, fetchImpl = globalThis.fetch,
  onUpdate = () => {}, now = Date.now, minimumInterval = 30_000 } = {}) {
  const base = new URL(baseURL);
  const markerURL = new URL('build.json', base);
  let pending = false;
  let request;
  let lastChecked = -Infinity;

  async function refreshCatalogs() {
    // These replaceable HTTP-cache entries belong to this deployment. The app
    // has no persistent CacheStorage cache; saved sites and images are separate.
    await Promise.allSettled(['assets/manifest.json', 'assets/version-catalog.json'].map(async path => {
      const response = await fetchImpl(new URL(path, base), {
        cache: 'reload', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) await response.arrayBuffer();
      else await response.body?.cancel();
    }));
  }

  return {
    get pending() { return pending; },
    check({ force = false } = {}) {
      if (pending || !BUILD_ID.test(loadedId || '')) return Promise.resolve(pending);
      if (request) return request;
      if (!force && now() - lastChecked < minimumInterval) return Promise.resolve(false);
      lastChecked = now();
      request = (async () => {
        try {
          const response = await fetchImpl(markerURL, {
            cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok || Number(response.headers.get('content-length')) > 1024) {
            await response.body?.cancel();
            return false;
          }
          const text = await response.text();
          if (text.length > 1024) return false;
          const marker = JSON.parse(text);
          if (marker.schemaVersion !== 1 || !BUILD_ID.test(marker.id || '') || marker.id === loadedId) return false;
          pending = true;
          onUpdate();
          await refreshCatalogs();
          return true;
        } catch {
          // Offline or older deployments remain usable. The ordinary manifest
          // and package loaders report any actual failure to launch.
          return pending;
        } finally { request = undefined; }
      })();
      return request;
    },
  };
}
