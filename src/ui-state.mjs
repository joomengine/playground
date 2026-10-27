const SITE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const PUBLIC_FIELDS = ['blueprintId', 'joomlaVersion', 'phpVersion', 'siteName', 'initialPath', 'storageKey', 'language', 'autoLogin', 'hideToolbar', 'persistence'];

/** Scope resume preferences to this deployment, like its browser database stores. */
export function savedStateKey(baseURL) {
  return `joomengine:launch:${new URL(baseURL).href}`;
}

export function defaultSiteKey(blueprintId, joomlaVersion) {
  const suffix = `-${joomlaVersion}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-33);
  const name = String(blueprintId || 'jcb').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'site';
  return `${name.slice(0, 64 - suffix.length)}${suffix}`;
}

/** Persist setup preferences, never administrator credentials or runtime objects. */
export function publicConfiguration(config) {
  const result = Object.fromEntries(PUBLIC_FIELDS.filter((name) => config[name] !== undefined).map((name) => [name, config[name]]));
  result.extensions = (config.extensions || []).map(({ url, sha256 }) => ({ url, ...(sha256 ? { sha256 } : {}) }));
  result.startupCommands = (config.startupCommands || []).map((argv) => [...argv]);
  result.fresh = false;
  return result;
}

export function readSavedState(storage, key) {
  const empty = () => ({ schemaVersion: 1, active: null, sites: Object.create(null) });
  try {
    const value = JSON.parse(storage.getItem(key));
    if (value?.schemaVersion !== 1 || !value.sites || typeof value.sites !== 'object' || Array.isArray(value.sites)) return empty();
    const result = empty();
    for (const [name, site] of Object.entries(value.sites).slice(-40)) {
      if (!SITE_KEY.test(name) || !site || typeof site !== 'object' || site.storageKey !== name || site.persistence !== true
          || !Array.isArray(site.extensions) || !Array.isArray(site.startupCommands)) continue;
      result.sites[name] = publicConfiguration(site);
    }
    if (typeof value.active === 'string' && Object.hasOwn(result.sites, value.active)) result.active = value.active;
    return result;
  } catch { return empty(); }
}

export function rememberSite(state, config) {
  if (!config.persistence || !SITE_KEY.test(config.storageKey)) return state;
  const sites = { ...state.sites };
  delete sites[config.storageKey];
  sites[config.storageKey] = publicConfiguration(config);
  const retained = Object.fromEntries(Object.entries(sites).slice(-40));
  return { schemaVersion: 1, active: config.storageKey, sites: retained };
}

export function forgetSite(state, storageKey) {
  const sites = { ...state.sites };
  delete sites[storageKey];
  return { schemaVersion: 1, active: state.active === storageKey ? null : state.active, sites };
}

/** Reflect selected controls without newly exposing manually entered setup steps. */
export function runtimeLocation(currentURL, config) {
  const url = new URL(currentURL);
  const params = url.searchParams;
  for (const [parameter, name] of [['blueprint', 'blueprintId'], ['joomla', 'joomlaVersion'], ['php', 'phpVersion'], ['language', 'language'], ['key', 'storageKey']]) {
    if (config[name]) params.set(parameter, config[name]);
  }
  params.set('path', config.initialPath || '/');
  params.set('login', config.autoLogin ? 'yes' : 'no');
  params.set('persist', config.persistence ? '1' : '0');
  params.set('toolbar', config.hideToolbar ? '0' : '1');
  params.delete('fresh');
  params.delete('initialPath');
  params.delete('hideToolbar');
  if (params.has('extensions') || params.has('extension')) {
    params.delete('extension');
    if (config.extensions?.length) params.set('extensions', JSON.stringify(config.extensions));
    else params.delete('extensions');
  }
  if (params.has('commands') || params.has('startupCommands')) {
    params.delete('startupCommands');
    if (config.startupCommands?.length) params.set('commands', JSON.stringify(config.startupCommands));
    else params.delete('commands');
  }
  return url.href;
}
