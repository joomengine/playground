import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeTheme, normalizeTheme, resolveTheme, syncThemeDocument, THEME_STORAGE_KEY } from '../src/theme.mjs';

function realm(initial, dark = false) {
  const values = new Map(initial ? [[THEME_STORAGE_KEY, initial]] : []);
  const listeners = new Set();
  const media = { matches: dark, addEventListener(_name, fn) { listeners.add(fn); }, removeEventListener(_name, fn) { listeners.delete(fn); } };
  const metas = new Map();
  const doc = new EventTarget();
  doc.documentElement = { dataset: {}, style: {} };
  doc.querySelector = selector => metas.get(selector.match(/name="([^"]+)"/)[1]);
  doc.createElement = () => ({});
  doc.head = { append(meta) { metas.set(meta.name, meta); } };
  const win = new EventTarget();
  win.CustomEvent = CustomEvent;
  win.matchMedia = () => media;
  win.sessionStorage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  doc.defaultView = win;
  const change = value => { media.matches = value; for (const fn of listeners) fn({ matches: value }); };
  return { document: doc, window: win, values, change, listeners, metas };
}

test('System follows live system changes; an explicit override wins until System returns', () => {
  const one = realm(); const events = [];
  one.document.addEventListener('joomengine:themechange', event => events.push(event.detail));
  const controller = initializeTheme(one);
  assert.equal(controller.state.preference, 'system');
  assert.equal(one.document.documentElement.dataset.theme, 'light');
  one.change(true); assert.equal(controller.state.resolved, 'dark');
  controller.set('light'); one.change(false); one.change(true);
  assert.equal(controller.state.resolved, 'light');
  assert.equal(one.values.get(THEME_STORAGE_KEY), 'light');
  controller.set('system'); assert.equal(controller.state.resolved, 'dark');
  assert.equal(one.metas.get('color-scheme').content, 'dark');
  assert.equal(events.length, 4);
  controller.dispose(); assert.equal(one.listeners.size, 0);
});

test('Separate tabs retain independent non-secret preferences and reload reads only its own session', () => {
  const one = realm('dark'), two = realm();
  const a = initializeTheme(one), b = initializeTheme(two);
  a.set('light'); two.change(true);
  assert.equal(b.state.preference, 'system'); assert.equal(b.state.resolved, 'dark');
  assert.equal(a.state.resolved, 'light');
  assert.equal(two.values.size, 0);
  a.dispose(); b.dispose();
  const reloaded = initializeTheme(one); assert.equal(reloaded.state.preference, 'light'); reloaded.dispose();
});

test('Unavailable session storage is optional; detached documents receive the resolved appearance', () => {
  const source = realm(); Object.defineProperty(source.window, 'sessionStorage', { get() { throw new Error('Disabled'); } });
  const controller = initializeTheme(source); controller.set('dark');
  const detached = realm(); syncThemeDocument(detached.document, controller.state);
  assert.equal(detached.document.documentElement.dataset.theme, 'dark');
  assert.equal(detached.document.documentElement.style.colorScheme, 'dark');
  assert.equal(detached.metas.get('theme-color').content, '#080a27');
  assert.throws(() => controller.set('sepia'), /Unknown/);
  controller.dispose();
});

test('Appearance validation rejects malformed persisted values', () => {
  assert.equal(normalizeTheme('LIGHT'), 'system');
  assert.equal(resolveTheme(null, true), 'dark');
  const one = realm('{broken'); const controller = initializeTheme(one);
  assert.equal(controller.state.preference, 'system'); controller.dispose();
});
