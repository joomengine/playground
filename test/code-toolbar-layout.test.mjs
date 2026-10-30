import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitToolbarActions } from '../src/code/toolbar-layout.mjs';

// Controlled layout measurements exercise fitting decisions; real browser tests
// additionally verify CSS geometry, keyboard focus, resize, and detached windows.
function fixture(labelWidths, width) {
  const root = { dataset: {} };
  const style = { display: 'inline-flex', position: 'static', marginLeft: '0', marginRight: '0', paddingLeft: '0', paddingRight: '0', columnGap: '4' };
  const toolbar = { ownerDocument: { defaultView: { getComputedStyle: () => style } }, clientWidth: width };
  toolbar.children = labelWidths.map(extra => {
    const classes = new Set();
    const control = { classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
      querySelector: () => ({}), getBoundingClientRect: () => ({ width: 32 + (classes.has('jec-action-icon') || ['icons', 'strip'].includes(root.dataset.actions) ? 0 : extra) }) };
    return control;
  });
  Object.defineProperty(toolbar, 'scrollWidth', { get: () => Math.max(toolbar.clientWidth,
    toolbar.children.reduce((sum, control) => sum + control.getBoundingClientRect().width, 0) + 4 * Math.max(0, toolbar.children.length - 1)) });
  const visible = () => toolbar.children.filter(control => !control.classList.contains('jec-action-icon')).length;
  return { root, toolbar, visible, fit() { fitToolbarActions(root, toolbar); } };
}

test('wide toolbar text returns after narrowing to icons or a scrolling strip', () => {
  const view = fixture([80, 90, 100, 70], 500);
  view.fit(); assert.equal(view.root.dataset.actions, 'labels'); assert.equal(view.visible(), 4);
  view.toolbar.clientWidth = 180; view.fit(); assert.equal(view.root.dataset.actions, 'icons');
  view.toolbar.clientWidth = 100; view.fit(); assert.equal(view.root.dataset.actions, 'strip');
  view.toolbar.clientWidth = 500; view.fit(); assert.equal(view.root.dataset.actions, 'labels'); assert.equal(view.visible(), 4);
});

test('intermediate widths use available space for words instead of hiding every label', () => {
  const view = fixture([80, 90, 100, 70], 400);
  view.fit(); assert.equal(view.root.dataset.actions, 'mixed'); assert.equal(view.visible(), 3);
  assert.ok(view.toolbar.scrollWidth <= view.toolbar.clientWidth);
});

test('one long translated action cannot suppress the other labels', () => {
  const view = fixture([3000, 80, 90, 100], 450);
  const original = [...view.toolbar.children];
  view.fit(); assert.equal(view.root.dataset.actions, 'mixed'); assert.equal(view.visible(), 3);
  assert.ok(view.toolbar.children[0].classList.contains('jec-action-icon'));
  assert.deepEqual(view.toolbar.children, original, 'Fitting preserves the actual controls and their state.');
});
