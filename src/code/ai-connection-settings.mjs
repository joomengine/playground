/** Public connection identity. This function is serialized into the isolated panel. */
export function aiConnectionIdentity(settings) {
  const provider = settings.provider || {};
  let baseURL = provider.id && provider.id !== 'other' ? provider.baseURL || '' : settings.baseURL || '';
  try { const url = new URL(baseURL); url.pathname = url.pathname.replace(/\/+$/, ''); baseURL = url.href.replace(/\/$/, ''); } catch { baseURL = String(baseURL).trim(); }
  return JSON.stringify({ provider: provider.id || 'other', baseURL,
    protocol: provider.id && provider.id !== 'other' ? provider.protocol : settings.protocol || 'openai',
    fields: Object.fromEntries((provider.fields || []).filter(field => !field.credential).map(field => [field.id, settings[field.id] || '']).sort(([a], [b]) => a.localeCompare(b))) });
}

/** One cancellable catalog operation; stale completions cannot alter newer UI state. */
export function createAiCatalogLoader({ createProvider, onLoading = () => {}, onError = () => {} }) {
  let active;
  function cancel() {
    const previous = active; active = undefined;
    if (!previous) return;
    previous.controller.abort(); previous.client.dispose(); onLoading(false);
  }
  async function load(settings) {
    cancel();
    const operation = { controller: new AbortController() };
    try {
      operation.client = createProvider(settings);
      active = operation; onLoading(true);
      const result = await operation.client.listModels({ signal: operation.controller.signal, currentModel: settings.model });
      return active === operation && !operation.controller.signal.aborted ? result : null;
    } catch (error) {
      if (!operation.controller.signal.aborted && (!active || active === operation)) onError(error);
      return null;
    } finally {
      operation.client?.dispose();
      if (active === operation) { active = undefined; onLoading(false); }
    }
  }
  return Object.freeze({ load, cancel });
}
