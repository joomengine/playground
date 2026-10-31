import { createShareURL } from './config.mjs';
const SITE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const PUBLIC_FIELDS = ['deployId', 'joomlaVersion', 'joomlaPackage', 'jcbVersion', 'jcbPackage', 'phpVersion', 'siteName', 'initialPath', 'storageKey', 'language', 'autoLogin', 'hideToolbar', 'persistence', 'phpSettings', 'menus', 'template', 'languageTags', 'multilingual', 'content'];

/** Approval must preserve command argument boundaries as well as source URLs. */
export function customSetupDetails(input) {
  const sources = [input.joomlaPackage?.url, input.jcbPackage?.url, ...(input.extensions || []).map(item => item.url), input.template?.url,
    ...(input.languages || []).map(item => item.url)].filter(Boolean);
  const commands = (input.startupCommands || []).map(command => [...command]);
  return { sources, commands, extensions: input.extensions || [], template: input.template || null,
    languages: input.languages || [], content: input.content || null, menus: input.menus || [],
    joomlaVersion: input.joomlaPackage ? input.joomlaVersion : null,
    joomlaPackage: input.joomlaPackage ? structuredClone(input.joomlaPackage) : null,
    jcbVersion: input.jcbPackage ? input.jcbVersion : null,
    jcbPackage: input.jcbPackage ? structuredClone(input.jcbPackage) : null };
}

/** Scope resume preferences to this deployment, like its browser database stores. */
export function savedStateKey(baseURL) {
  return `joomengine:launch:${new URL(baseURL).href}`;
}

export function defaultSiteKey(deployId, joomlaVersion) {
  const suffix = `-${joomlaVersion}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-33);
  const name = String(deployId || 'jcb').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || 'site';
  return `${name.slice(0, 64 - suffix.length)}${suffix}`;
}

/** Persist setup preferences, never administrator credentials or runtime objects. */
export function publicConfiguration(config) {
  const result = Object.fromEntries(PUBLIC_FIELDS.filter((name) => config[name] !== undefined).map((name) => [name, structuredClone(config[name])]));
  result.extensions = (config.extensions || []).map(({ url, sha256, sha512 }) => ({ url, ...(sha256 ? { sha256 } : {}), ...(sha512 ? { sha512 } : {}) }));
  result.languages = (config.languages || []).map(({ tag, url, sha256 }) => ({ tag, url, ...(sha256 ? { sha256 } : {}) }));
  result.startupCommands = (config.startupCommands || []).map((argv) => [...argv]);
  result.fresh = false;
  return result;
}

export function readSavedState(storage, key) {
  const empty = () => ({ schemaVersion: 2, active: null, sites: Object.create(null) });
  try {
    const value = JSON.parse(storage.getItem(key));
    if (![1, 2].includes(value?.schemaVersion) || !value.sites || typeof value.sites !== 'object' || Array.isArray(value.sites)) return empty();
    const result = empty();
    for (const [name, site] of Object.entries(value.sites)) {
      if (!SITE_KEY.test(name) || !site || typeof site !== 'object' || site.storageKey !== name || site.persistence !== true
          || !Array.isArray(site.extensions) || !Array.isArray(site.startupCommands)) continue;
      try {
        result.sites[name] = { ...publicConfiguration(site), displayName: savedSiteName(site.displayName || site.siteName), lastPath: safeSavedRoute(site.lastPath, site.initialPath) };
      } catch { /* A damaged entry must not hide the other saved installations. */ }
    }
    if (typeof value.active === 'string' && Object.hasOwn(result.sites, value.active)) result.active = value.active;
    return result;
  } catch { return empty(); }
}

export function rememberSite(state, config) {
  if (!config.persistence || !SITE_KEY.test(config.storageKey)) return state;
  const sites = { ...state.sites };
  delete sites[config.storageKey];
  const previous = state.sites[config.storageKey];
  sites[config.storageKey] = { ...publicConfiguration(config),
    displayName: savedSiteName(config.displayName || previous?.displayName || config.siteName),
    lastPath: safeSavedRoute(config.lastPath || previous?.lastPath, config.initialPath) };
  return { schemaVersion: 2, active: config.storageKey, sites };
}

export function forgetSite(state, storageKey) {
  const sites = { ...state.sites };
  delete sites[storageKey];
  return { schemaVersion: 2, active: state.active === storageKey ? null : state.active, sites };
}


/** Display names are metadata, never part of a recipe or the storage identity. */
export function savedSiteName(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) || 'Joomla site' : 'Joomla site';
}
export function renameSavedSite(state, storageKey, displayName) {
  if (!Object.hasOwn(state.sites, storageKey)) return state;
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100 || /[\x00-\x1f\x7f]/.test(displayName)) throw new TypeError('Enter a site name of 1–100 characters.');
  return { ...state, sites: { ...state.sites, [storageKey]: { ...state.sites[storageKey], displayName: displayName.trim() } } };
}

/** Resume navigation, never commands, credentials, CSRF tokens or external URLs. */
export function safeSavedRoute(value, fallback = '/') {
  function normalize(input) {
    if (typeof input !== 'string' || input.length > 2048 || !input.startsWith('/') || input.startsWith('//') || /[\\\x00-\x20\x7f]/.test(input)) return null;
    let decoded;
    try { decoded = decodeURIComponent(input.split(/[?#]/)[0]); } catch { return null; }
    if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.startsWith('//') || decoded.split('/').some(part => part === '.' || part === '..')) return null;
    const url = new URL(input, 'https://saved-site.invalid');
    if (url.origin !== 'https://saved-site.invalid') return null;
    const safe = new URLSearchParams();
    const allowed = new Set(['option', 'view', 'layout', 'id', 'Itemid', 'lang', 'limit', 'limitstart', 'start', 'tmpl']);
    for (const [key, item] of url.searchParams) {
      if (allowed.has(key) && /^[a-zA-Z0-9_.:, -]{1,128}$/.test(item)) safe.append(key, item);
    }
    const query = safe.toString();
    const hash = /^#[a-zA-Z0-9_-]{1,128}$/.test(url.hash) ? url.hash : '';
    return `${url.pathname}${query ? `?${query}` : ''}${hash}`;
  }
  return normalize(value) || normalize(fallback) || '/';
}
/** Check only a resumed route; HEAD never submits a saved form or action. */
export async function resolveResumePath(request, path, fallback = '/') {
  const initial = safeSavedRoute(fallback);
  const route = safeSavedRoute(path, initial);
  if (route === initial) return route;
  try {
    const response = await request(route, { method: 'HEAD' });
    await response.body?.cancel();
    return response.status === 404 || response.status === 410 ? initial : route;
  } catch { return initial; }
}

export function rememberSiteRoute(state, storageKey, path) {
  if (!Object.hasOwn(state.sites, storageKey)) return state;
  const lastPath = safeSavedRoute(path, state.sites[storageKey].initialPath);
  if (state.sites[storageKey].lastPath === lastPath) return state;
  return { ...state, sites: { ...state.sites, [storageKey]: { ...state.sites[storageKey], lastPath } } };
}

/** Reflect selected controls without newly exposing manually entered setup steps. */
export function runtimeLocation(currentURL, config) {
  const url = new URL(currentURL);
  const inbound = url.hash.startsWith('#deploy=') || url.searchParams.has('config');
  if (inbound) {
    url.hash = '';
    url.searchParams.delete('config');
    url.searchParams.delete('sha256');
    if (!config.persistence) {
      try {
        const refreshed = new URL(createShareURL(currentURL, config));
        url.search = refreshed.search; url.hash = refreshed.hash;
      } catch { /* Local operation succeeds even when the updated setup cannot be put in a public link. */ }
    }
  }
  const params = url.searchParams;
  if (config.siteName) params.set('name', config.siteName);
  else params.delete('name');
  for (const [parameter, name] of [['deploy', 'deployId'], ['joomla', 'joomlaVersion'], ['jcb', 'jcbVersion'], ['php', 'phpVersion'], ['language', 'language'], ['key', 'storageKey']]) {
    if (config[name]) params.set(parameter, config[name]);
    else if (name === 'jcbVersion') params.delete(parameter);
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

/** A changed setup recipe must not silently reopen a site built with older steps. */
export async function isolateSetup(state, config) {
  const previous = Object.hasOwn(state.sites, config.storageKey) ? state.sites[config.storageKey] : null;
  const signature = (value) => JSON.stringify({ joomlaPackage: value.joomlaPackage ?? null, jcbVersion: value.jcbVersion ?? null, jcbPackage: value.jcbPackage ?? null, extensions: value.extensions || [], startupCommands: value.startupCommands || [], siteName: value.siteName, menus: value.menus || [], template: value.template || null, languageTags: value.languageTags || [], multilingual: value.multilingual || false, content: value.content || null });
  if (!config.persistence || !previous || signature(previous) === signature(config)) return { configuration: config, changed: false };
  const content = JSON.stringify({ key: config.storageKey, deployId: config.deployId, joomlaVersion: config.joomlaVersion, setup: signature(config) });
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = `${config.storageKey.slice(0, 40)}-setup-${digest.slice(0, 16)}`;
  return { configuration: { ...config, storageKey: key }, changed: true, previousKey: config.storageKey };
}
