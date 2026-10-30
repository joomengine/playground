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

test('A manual appearance toggle yields to the next system change and stays aligned on reload', () => {
  const one = realm(); const events = [];
  one.document.addEventListener('joomengine:themechange', event => events.push(event.detail));
  let controller = initializeTheme(one);
  assert.equal(controller.state.preference, 'system');
  assert.equal(one.document.documentElement.dataset.theme, 'light');
  controller.set('dark');
  assert.equal(controller.state.resolved, 'dark');
  assert.equal(one.values.get(THEME_STORAGE_KEY), 'dark');
  one.change(true);
  assert.equal(controller.state.preference, 'system');
  assert.equal(controller.state.resolved, 'dark');
  assert.equal(one.values.get(THEME_STORAGE_KEY), 'system');
  one.change(false);
  assert.equal(controller.state.resolved, 'light');
  assert.equal(one.metas.get('color-scheme').content, 'light');
  assert.equal(events.length, 4);
  controller.dispose(); assert.equal(one.listeners.size, 0);
  controller = initializeTheme(one);
  assert.equal(controller.state.preference, 'system');
  assert.equal(controller.state.resolved, 'light');
  controller.dispose();
});

test('A manual light override also yields when the system switches back to light, then dark', () => {
  const one = realm(undefined, true);
  const controller = initializeTheme(one);
  controller.set('light'); assert.equal(controller.state.resolved, 'light');
  one.change(false); assert.equal(controller.state.preference, 'system');
  one.change(true); assert.equal(controller.state.resolved, 'dark');
  controller.dispose();
});

test('Separate tabs retain independent non-secret preferences and reload reads only its own session', () => {
  const one = realm('dark'), two = realm();
  const a = initializeTheme(one), b = initializeTheme(two);
  a.set('light'); two.change(true);
  assert.equal(b.state.preference, 'system'); assert.equal(b.state.resolved, 'dark');
  assert.equal(a.state.resolved, 'light');
  assert.equal(two.values.get(THEME_STORAGE_KEY), 'system');
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
  source.change(true); source.change(false);
  assert.equal(controller.state.preference, 'system');
  assert.equal(controller.state.resolved, 'light');
  assert.throws(() => controller.set('sepia'), /Unknown/);
  controller.dispose();
});

test('Appearance validation rejects malformed persisted values', () => {
  assert.equal(normalizeTheme('LIGHT'), 'system');
  assert.equal(resolveTheme(null, true), 'dark');
  const one = realm('{broken'); const controller = initializeTheme(one);
  assert.equal(controller.state.preference, 'system'); controller.dispose();
});
