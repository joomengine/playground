import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCodeLayout } from '../src/code/layout.mjs';

test('layout preferences reject unknown modes and malformed dimensions', () => {
  const normalized = normalizeCodeLayout({ mode: 'external', x: NaN, y: Infinity, width: -10, height: '900', dock: 300 });
  assert.equal(normalized.mode, 'right');
  assert.equal(normalized.width, 320);
  assert.equal(normalized.height, 580);
  assert.equal(normalized.dock, 75);
  for (const value of Object.values(normalized).slice(1)) assert.equal(Number.isFinite(value), true);
  assert.equal(normalizeCodeLayout(null).mode, 'right');
});

test('all floating controls remain reachable after a smaller viewport or monitor change', () => {
  const state = normalizeCodeLayout({ mode: 'floating', x: 1900, y: 900, width: 1200, height: 800 }, { width: 390, height: 844 });
  assert.equal(state.mode, 'floating');
  assert.ok(state.x >= 0 && state.y >= 0);
  assert.ok(state.x + state.width <= 390);
  assert.ok(state.y + state.height <= 844);
  assert.ok(state.width >= 320);
});

test('very small viewports can still reach the top bar instead of enforcing desktop minimums', () => {
  const state = normalizeCodeLayout({ width: 1000, height: 1000, x: -999, y: -999 }, { width: 240, height: 180 });
  assert.ok(state.x >= 0 && state.y >= 0);
  assert.ok(state.x + state.width <= 240);
  assert.ok(state.y + state.height <= 180);
  assert.ok(state.width > 0 && state.height > 0);
});

test('valid desktop preferences preserve mode, dock fraction and floating geometry', () => {
  const input = { mode: 'left', dock: 44, bottom: 320, x: 30, y: 50, width: 640, height: 480 };
  assert.deepEqual(normalizeCodeLayout(input, { width: 1600, height: 1000 }), input);
});
