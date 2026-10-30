/** Non-secret appearance belongs to this tab, not a global cross-tab preference. */
export const THEME_STORAGE_KEY = 'joomengine.appearance.session.v1';
export const THEME_PREFERENCES = Object.freeze(['system', 'light', 'dark']);
const controllers = new WeakMap();
let active;
export function normalizeTheme(value) { return THEME_PREFERENCES.includes(value) ? value : 'system'; }
export function resolveTheme(preference, systemDark = false) {
  return normalizeTheme(preference) === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}
export function syncThemeDocument(doc, state) {
  if (!doc?.documentElement) return;
  const resolved = state?.resolved === 'dark' || state?.theme === 'dark' ? 'dark' : 'light';
  doc.documentElement.dataset.theme = resolved;
  doc.documentElement.dataset.themePreference = normalizeTheme(state?.preference);
  doc.documentElement.style.colorScheme = resolved;
  const color = resolved === 'dark' ? '#080a27' : '#f5f7fc';
  for (const [name, content] of [['color-scheme', resolved], ['theme-color', color]]) {
    let meta = doc.querySelector(`meta[name="${name}"]`);
    if (!meta && doc.head) { meta = doc.createElement('meta'); meta.name = name; doc.head.append(meta); }
    if (meta) meta.content = content;
  }
}
export function initializeTheme({ document: doc = globalThis.document, window: win = doc?.defaultView ?? globalThis.window, storage } = {}) {
  if (!doc || !win) return undefined;
  if (controllers.has(doc)) { active = controllers.get(doc); return active; }
  let saved;
  try { storage ??= win.sessionStorage; saved = storage?.getItem(THEME_STORAGE_KEY); } catch { /* Private contexts may disable storage. */ }
  const media = win.matchMedia?.('(prefers-color-scheme: dark)');
  let preference = normalizeTheme(saved), disposed = false;
  const state = () => ({ preference, resolved: resolveTheme(preference, Boolean(media?.matches)), theme: resolveTheme(preference, Boolean(media?.matches)) });
  function apply() {
    if (disposed) return;
    const detail = state();
    syncThemeDocument(doc, detail);
    for (const type of ['joomengine:themechange', 'rocket:themechange']) {
      if (typeof win.CustomEvent === 'function') {
        doc.dispatchEvent(new win.CustomEvent(type, { detail }));
        win.dispatchEvent(new win.CustomEvent(type, { detail }));
      }
    }
  }
  // A manual toggle lasts until the next operating-system appearance change.
  // Persist the return to automatic alignment so reloading cannot revive it.
  const systemChanged = () => {
    preference = 'system';
    try { storage?.setItem(THEME_STORAGE_KEY, preference); } catch { /* Storage is optional. */ }
    apply();
  };
  if (media?.addEventListener) media.addEventListener('change', systemChanged);
  else media?.addListener?.(systemChanged);
  const controller = {
    get state() { return state(); },
    set(value) {
      if (!THEME_PREFERENCES.includes(value)) throw new TypeError('Unknown appearance preference.');
      preference = value;
      try { storage?.setItem(THEME_STORAGE_KEY, preference); } catch { /* Appearance still works in memory. */ }
      apply(); return state();
    },
    dispose() {
      disposed = true;
      if (media?.removeEventListener) media.removeEventListener('change', systemChanged);
      else media?.removeListener?.(systemChanged);
      controllers.delete(doc);
      if (active === controller) active = undefined;
    },
  };
  controllers.set(doc, controller); active = controller; apply();
  return controller;
}
export function getThemeState() {
  return active?.state ?? { preference: 'system', resolved: 'light', theme: 'light' };
}
export function setTheme(value) {
  const controller = active ?? initializeTheme();
  if (!controller) throw new Error('Appearance needs a browser document.');
  return controller.set(value);
}
