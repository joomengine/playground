/** Public transport configuration: omit the endpoint to use Fetch directly. */
export function normalizeNetworkConfig(raw = {}) {
  return Object.freeze({ endpoint: typeof raw?.endpoint === 'string' && raw.endpoint ? raw.endpoint : null });
}

const configurations = new Map();
/** Proxy configuration is optional; a missing endpoint never disables direct networking. */
export function loadNetworkConfiguration(baseURL, fetcher) {
  const url = new URL('config/network.json', baseURL);
  const load = async () => {
    try {
      const response = await (fetcher ?? globalThis.fetch.bind(globalThis))(url);
      return response.ok ? normalizeNetworkConfig(await response.json()) : normalizeNetworkConfig();
    } catch { return normalizeNetworkConfig(); }
  };
  if (fetcher) return load();
  if (!configurations.has(url.href)) configurations.set(url.href, load());
  return configurations.get(url.href);
}
