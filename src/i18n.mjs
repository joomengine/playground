import english from './locales/en.mjs';

export const UI_LANGUAGES = Object.freeze([
  ['en', 'English'], ['af', 'Afrikaans'], ['de', 'Deutsch'], ['fr', 'Français'],
  ['it', 'Italiano'], ['es', 'Español'], ['zh-CN', '简体中文'], ['nl', 'Nederlands'],
  ['he', 'עברית', 'rtl'], ['el', 'Ελληνικά'], ['ar', 'العربية', 'rtl'], ['pt', 'Português'],
  ['ru', 'Русский'], ['ja', '日本語'], ['ko', '한국어'], ['hi', 'हिन्दी'],
  ['bn', 'বাংলা'], ['tr', 'Türkçe'], ['id', 'Bahasa Indonesia'], ['uk', 'Українська'],
].map(([code, label, direction = 'ltr']) => Object.freeze({ code, label, direction })));

export const UI_LOCALE_STORAGE_KEY = 'joomengine.rocket.interface-language.v1';
const supported = new Map(UI_LANGUAGES.map((language) => [language.code.toLowerCase(), language]));
const loaded = new Map([['en', english]]);
let current = 'en';
let selection = 0;

export function normalizeLocale(value) {
  if (typeof value !== 'string') return 'en';
  const normalized = value.trim().replaceAll('_', '-').toLowerCase();
  return supported.get(normalized)?.code || supported.get(normalized.split('-')[0])?.code
    || (normalized === 'zh' || normalized.startsWith('zh-hans') ? 'zh-CN' : 'en');
}

export function getLocale() { return current; }
export function getDirection(locale = current) {
  return supported.get(normalizeLocale(locale).toLowerCase())?.direction || 'ltr';
}

export function t(key, values = {}) {
  const message = loaded.get(current)?.[key] ?? english[key] ?? key;
  return String(message).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (token, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : token);
}

export async function loadLocale(locale) {
  const code = normalizeLocale(locale);
  if (!loaded.has(code)) {
    const messages = (await import(`./locales/${code}.mjs`)).default;
    loaded.set(code, messages);
  }
  return loaded.get(code);
}

export function applyTranslations(root = globalThis.document) {
  if (!root) return;
  const document = root.nodeType === 9 ? root : root.ownerDocument;
  if (document?.documentElement) {
    document.documentElement.lang = current;
    document.documentElement.dir = getDirection();
  }
  const translate = (element) => {
    const key = element.getAttribute('data-i18n');
    if (key) element.textContent = t(key);
    for (const attribute of ['title', 'placeholder', 'aria-label']) {
      const attributeKey = element.getAttribute(`data-i18n-${attribute}`);
      if (attributeKey) element.setAttribute(attribute, t(attributeKey));
    }
  };
  if (root.nodeType === 1) translate(root);
  root.querySelectorAll?.('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]').forEach(translate);
}

export async function setLocale(locale, { root = globalThis.document, persist = true, storage } = {}) {
  const requested = normalizeLocale(locale);
  const request = ++selection;
  await loadLocale(requested);
  if (request !== selection) return current;
  current = requested;
  if (persist) {
    try { (storage ?? globalThis.localStorage)?.setItem(UI_LOCALE_STORAGE_KEY, current); }
    catch { /* Interface preferences are optional when storage is unavailable. */ }
  }
  applyTranslations(root);
  const document = root?.nodeType === 9 ? root : root?.ownerDocument;
  if (document?.dispatchEvent && typeof globalThis.CustomEvent === 'function') {
    document.dispatchEvent(new CustomEvent('rocket:languagechange', { detail: { locale: current, direction: getDirection() } }));
  }
  return current;
}

export async function initializeLocale({ root = globalThis.document, search = globalThis.location?.search || '', storage } = {}) {
  const explicit = new URLSearchParams(search).get('uiLanguage');
  let saved;
  try { saved = (storage ?? globalThis.localStorage)?.getItem(UI_LOCALE_STORAGE_KEY); }
  catch { /* English is the default when preference storage cannot be read. */ }
  return setLocale(explicit ?? saved ?? 'en', { root, storage, persist: explicit !== null });
}
