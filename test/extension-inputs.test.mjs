import assert from 'node:assert/strict';
import test from 'node:test';
import { createExtensionInputs } from '../src/extension-inputs.mjs';

// Only the DOM methods used by this controller; real browser interaction is
// covered separately by extension-inputs.browser.mjs.
class Element {
  constructor(document, tag = 'div') {
    this.ownerDocument = document; this.tag = tag; this.listeners = new Map();
    this.attributes = new Map(); this.children = []; this.value = ''; this.open = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  setCustomValidity(message) { this.validationMessage = message; }
  focus() { this.ownerDocument.activeElement = this; }
  addEventListener(type, callback) {
    const values = this.listeners.get(type) || []; values.push(callback); this.listeners.set(type, values);
  }
  dispatch(type, extra = {}) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const callback of this.listeners.get(type) || []) callback(event);
    return event;
  }
}
const messages = {
  'error.extensionJson': 'Correct the extension JSON before editing the URL fields.',
  'error.extensionLimit': 'Choose at most 30 extension packages.',
  'error.extensionUrl': 'Enter a complete HTTP or HTTPS URL for extension {number}.',
  'label.extensionUrlNumber': 'Extension ZIP URL {number}',
  'action.removeExtensionUrl': 'Remove extension URL {number}',
  'action.addExtensionUrl': 'Add another URL',
};
function fixture() {
  const document = { createElement(tag) { return new Element(document, tag); } };
  const textarea = document.createElement('textarea'); textarea.value = '[]';
  const rows = document.createElement('div'), addButton = document.createElement('button');
  const advanced = document.createElement('details'), errorElement = document.createElement('p'); errorElement.id = 'extension-error';
  let changes = 0;
  const controller = createExtensionInputs({ textarea, rows, addButton, advanced, errorElement,
    baseURL: 'https://playground.test/path/', onChange: () => changes++,
    t: (key, values = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (_, name) => values[name]),
  });
  const input = index => rows.children[index].children[0].children[1];
  const remove = index => rows.children[index].children[1];
  const type = (index, value) => { input(index).value = value; input(index).dispatch('input'); };
  const json = value => { textarea.value = value; textarea.dispatch('input'); };
  return { ...controller, textarea, rows, addButton, advanced, errorElement, input, remove, type, json, document, changes: () => changes };
}

test('URL rows add, edit, remove and ignore unused blank rows without JSON knowledge', () => {
  const editor = fixture();
  assert.equal(editor.rows.children.length, 1);
  assert.deepEqual(editor.read(), []);
  editor.type(0, 'https://example.test/one.zip');
  editor.addButton.dispatch('click');
  assert.equal(editor.rows.children.length, 2);
  assert.deepEqual(editor.read(), [{ url: 'https://example.test/one.zip' }]);
  editor.type(1, 'http://example.test/two.zip');
  assert.deepEqual(editor.read(), [{ url: 'https://example.test/one.zip' }, { url: 'http://example.test/two.zip' }]);
  editor.remove(0).dispatch('click');
  assert.equal(editor.input(0).id, 'package-url');
  assert.deepEqual(editor.read(), [{ url: 'http://example.test/two.zip' }]);
  editor.remove(0).dispatch('click');
  assert.equal(editor.rows.children.length, 1);
  assert.deepEqual(editor.read(), []);
  assert.ok(editor.changes() >= 5);
});

test('managed URL checksums are retained while custom checksum metadata is ignored', () => {
  const editor = fixture(), sha256 = 'ab'.repeat(32);
  editor.setValue([{ url: '/one.zip', sha256 }, { url: 'https://example.test/two.zip' }], { managed: [{ url: '/one.zip', sha256 }] });
  assert.equal(editor.input(0).value, 'https://playground.test/one.zip');
  editor.type(1, 'https://example.test/changed.zip');
  assert.equal(editor.read()[0].sha256, sha256);
  editor.type(0, 'https://playground.test/replacement.zip');
  assert.equal(editor.read()[0].sha256, undefined);
  const draft = '[\n {"url":"./advanced.zip","sha256":"' + sha256 + '"}\n]';
  editor.json(draft);
  assert.equal(editor.textarea.value, draft, 'A valid JSON draft must retain its formatting until edited through rows.');
  assert.equal(editor.input(0).value, 'https://playground.test/path/advanced.zip');
  assert.equal(editor.read()[0].sha256, undefined);
  editor.json('[{"url":"https://example.test/custom.zip","sha256":"not-a-digest"}]');
  assert.deepEqual(editor.read(), [{ url: 'https://example.test/custom.zip' }]);
});

test('malformed or unsupported JSON remains intact and cannot be overwritten through stale rows', () => {
  const editor = fixture(); editor.type(0, 'https://example.test/one.zip');
  for (const malformed of ['[{"url":', '["https://example.test/string.zip"]', '{"url":"https://example.test/object.zip"}', '[{"url":"ftp://example.test/one.zip"}]']) {
    editor.json(malformed);
    assert.equal(editor.textarea.value, malformed);
    assert.equal(editor.input(0).value, 'https://example.test/one.zip');
    assert.equal(editor.input(0).disabled, true);
    assert.equal(editor.addButton.disabled, true);
    editor.addButton.dispatch('click'); editor.remove(0).dispatch('click');
    assert.equal(editor.textarea.value, malformed);
    editor.advanced.open = false; editor.advanced.dispatch('toggle');
    assert.equal(editor.advanced.open, true);
    assert.throws(() => editor.read());
    assert.equal(editor.document.activeElement, editor.textarea);
    editor.refresh(); assert.equal(editor.textarea.value, malformed);
  }
  editor.json('[{"url":"https://example.test/repaired.zip"}]');
  assert.equal(editor.input(0).disabled, false);
  assert.equal(editor.addButton.disabled, false);
  assert.equal(editor.errorElement.hidden, true);
  assert.equal(editor.read()[0].url, 'https://example.test/repaired.zip');
});

test('simple URLs require an explicit HTTP scheme and keep invalid entry errors in simple mode', () => {
  const editor = fixture();
  for (const value of ['example.test/package.zip', '/relative.zip', 'file:///tmp/package.zip', 'javascript:alert(1)', 'https://user:secret@example.test/package.zip']) {
    editor.type(0, value);
    assert.throws(() => editor.read());
    assert.equal(editor.advanced.open, false);
    assert.equal(editor.document.activeElement, editor.input(0));
    assert.equal(editor.input(0).getAttribute('aria-invalid'), 'true');
    assert.equal(editor.input(0).disabled, false);
  }
  editor.type(0, 'https://example.test/valid.zip');
  assert.equal(editor.input(0).getAttribute('aria-invalid'), 'false');
  assert.equal(editor.read().length, 1);
});

test('at most 30 rows are offered and Enter does not submit the deployment form', () => {
  const editor = fixture();
  editor.setValue(Array.from({ length: 30 }, (_, index) => ({ url: `https://example.test/${index}.zip` })));
  assert.equal(editor.addButton.disabled, true);
  editor.addButton.dispatch('click'); assert.equal(editor.rows.children.length, 30);
  assert.equal(editor.input(0).dispatch('keydown', { key: 'Enter' }).defaultPrevented, true);
  assert.equal(editor.input(0).dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  editor.remove(29).dispatch('click'); assert.equal(editor.addButton.disabled, false);
  const previous = editor.textarea.value;
  assert.throws(() => editor.setValue([{ url: 'data:text/plain,bad' }]));
  assert.equal(editor.textarea.value, previous, 'Failed imports leave the previous form intact.');
});
