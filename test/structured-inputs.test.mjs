import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredInputs, structuredValue } from '../src/structured-inputs.mjs';

class Element {
  constructor(document, tag) {
    this.ownerDocument = document; this.tag = tag; this.children = []; this.listeners = new Map();
    this.attributes = new Map(); this.value = ''; this.classList = { add() {} };
  }
  append(...nodes) { for (const node of nodes) this.children.push(...(node.tag === 'fragment' ? node.children : [node])); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  setCustomValidity(value) { this.validationMessage = value; }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    const tags = selector.split(',');
    return this.children.flatMap(child => [...(tags.includes(child.tag) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  dispatch(name) { for (const callback of this.listeners.get(name) || []) callback({ target: this }); }
}
function fixture(kind, value) {
  const document = { createElement(tag) { return new Element(document, tag); }, createDocumentFragment() { return new Element(document, 'fragment'); } };
  const textarea = document.createElement('textarea'), container = document.createElement('div');
  const advanced = document.createElement('details'), errorElement = document.createElement('p');
  textarea.value = JSON.stringify(value);
  const api = createStructuredInputs({ textarea, container, advanced, errorElement, kind });
  const find = label => container.querySelectorAll('input,textarea,select,button').find(control => control.attributes.get('aria-label') === label);
  const type = (label, value) => { const control = find(label); assert.ok(control, label); control.value = value; control.dispatch('input'); };
  const json = value => { textarea.value = value; textarea.dispatch('input'); };
  return { ...api, find, type, json, textarea, container, advanced, errorElement, document };
}

test('structured values copy nested JSON without changing types or exact argument text', () => {
  const input = { values: [null, false, 0, '  text\nwith spaces  '], nested: { enabled: true } };
  const copy = structuredValue(input);
  assert.deepEqual(copy, input);
  copy.nested.enabled = false;
  assert.equal(input.nested.enabled, true);
});

test('structured editors reject unsafe or non-JSON data before creating controls', () => {
  for (const value of [undefined, NaN, Infinity, new Date(), JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.throws(() => structuredValue(value), TypeError);
  }
  const nested = {}; let parent = nested;
  for (let index = 0; index < 12; index++) { parent.child = {}; parent = parent.child; }
  assert.throws(() => structuredValue(nested), /too complex/);
});

test('command fields preserve argument boundaries and exact text through structural changes', () => {
  const editor = fixture('commands', [['config:set', 'sitename', 'first']]);
  editor.type('Command 1 argument 2', '  exact "quoted" value\nnext line  ');
  editor.find('Add argument to command 1').dispatch('click');
  editor.type('Command 1 argument 3', '--flag=value with spaces');
  assert.deepEqual(editor.read(), [['config:set', 'sitename', '  exact "quoted" value\nnext line  ', '--flag=value with spaces']]);
  editor.find('Remove command 1 argument 1').dispatch('click');
  assert.deepEqual(editor.read(), [['config:set', '  exact "quoted" value\nnext line  ', '--flag=value with spaces']]);
});

test('basic nested edits preserve unrelated values and incomplete numeric drafts', () => {
  const editor = fixture('parameters', { title: 'Old', nested: { enabled: true, count: 3 }, choices: [null, false, 'one'] });
  editor.type('Parameters: Title value', 'New');
  editor.type('Parameters: Nested: Count value', 'unfinished');
  editor.refresh();
  assert.equal(editor.find('Parameters: Nested: Count value').value, 'unfinished');
  assert.throws(() => editor.read(), /finite number/);
  editor.type('Parameters: Nested: Count value', '4.25');
  assert.deepEqual(editor.read(), { title: 'New', nested: { enabled: true, count: 4.25 }, choices: [null, false, 'one'] });
});

test('invalid advanced JSON remains intact and cannot be overwritten by stale basic controls', () => {
  const editor = fixture('parameters', { title: 'Kept' });
  editor.json('{"unfinished":');
  assert.equal(editor.find('Parameters: Title value').disabled, true);
  editor.find('Add field to Parameters').dispatch('click');
  assert.equal(editor.textarea.value, '{"unfinished":');
  assert.throws(() => editor.read());
  assert.equal(editor.advanced.open, true);
  editor.json('{"nested":{"values":[1,"two",false,null]}}');
  assert.deepEqual(editor.read(), { nested: { values: [1, 'two', false, null] } });
  assert.equal(editor.find('Parameters field name').disabled, false);
});
