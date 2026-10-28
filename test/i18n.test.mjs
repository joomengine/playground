import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import english from '../src/locales/en.mjs';
import { UI_LANGUAGES, UI_LOCALE_STORAGE_KEY, applyTranslations, getDirection, getLocale, initializeLocale, loadLocale, normalizeLocale, setLocale, t } from '../src/i18n.mjs';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test('Rocket starts in English and its language is independent of Joomla deployment language', async () => {
  const storage = memoryStorage();
  await initializeLocale({ root: undefined, search: '?language=af-ZA&deploy=heritage-demo', storage });
  assert.equal(getLocale(), 'en');
  assert.equal(storage.values.size, 0);
  await initializeLocale({ root: undefined, search: '?language=de-DE&uiLanguage=af', storage });
  assert.equal(getLocale(), 'af');
  assert.equal(storage.getItem(UI_LOCALE_STORAGE_KEY), 'af');
  await initializeLocale({ root: undefined, search: '?language=fr-FR', storage });
  assert.equal(getLocale(), 'af');
  await initializeLocale({ root: undefined, search: '?uiLanguage=../../other', storage });
  assert.equal(getLocale(), 'en');
  assert.equal(normalizeLocale('zh-Hans'), 'zh-CN');
  assert.equal(normalizeLocale('en-GB'), 'en');
});

test('Every selectable interface language translates the complete UI and preserves interpolated fields', async () => {
  const placeholders = message => [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
  for (const { code } of UI_LANGUAGES) {
    const messages = await loadLocale(code);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort(), code);
    for (const [key, message] of Object.entries(messages)) {
      assert.equal(typeof message, 'string', `${code}: ${key}`);
      assert.ok(message.trim(), `${code}: ${key}`);
      assert.deepEqual(placeholders(message), placeholders(english[key]), `${code}: ${key}`);
    }
    if (code !== 'en') {
      for (const key of ['action.save', 'action.share', 'label.interfaceLanguage', 'help.share', 'footer.affiliation']) {
        assert.notEqual(messages[key], english[key], `${code}: ${key} must be translated`);
      }
    }
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const [, key] of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
    assert.ok(Object.hasOwn(english, key), `HTML references missing translation ${key}`);
  }
});

test('Hebrew and Arabic update document direction, while translated content is assigned as plain text', async () => {
  const attributes = new Map([['data-i18n', 'action.share'], ['data-i18n-aria-label', 'title.share']]);
  const element = { nodeType: 1, textContent: '', getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value) };
  const document = { nodeType: 9, documentElement: {}, querySelectorAll: () => [element] };
  element.ownerDocument = document;
  await setLocale('he', { root: document, persist: false });
  assert.equal(document.documentElement.dir, 'rtl');
  assert.equal(document.documentElement.lang, 'he');
  assert.equal(element.textContent, 'שיתוף');
  assert.equal(attributes.get('aria-label'), 'שיתוף פריסה זו');
  assert.equal(getDirection('ar'), 'rtl');
  await setLocale('af', { root: document, persist: false });
  assert.equal(document.documentElement.dir, 'ltr');
  assert.equal(element.textContent, 'Deel');
  assert.equal(t('status.savedAt', { time: '<img src=x onerror=alert(1)>' }), 'Plaaslik gestoor om <img src=x onerror=alert(1)>');
  assert.equal(t('constructor'), 'constructor');
  assert.equal(t('missing.key'), 'missing.key');
  applyTranslations(element);
});

test('Unavailable preference storage does not prevent translation and the latest language selection wins', async () => {
  const storage = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } };
  await initializeLocale({ search: '', storage });
  assert.equal(getLocale(), 'en');
  await setLocale('el', { storage });
  assert.equal(t('action.save'), 'Αποθήκευση');
  await Promise.all([setLocale('he', { persist: false }), setLocale('en', { persist: false })]);
  assert.equal(getLocale(), 'en');
});
