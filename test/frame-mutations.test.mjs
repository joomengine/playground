import assert from 'node:assert/strict';
import test from 'node:test';
import { hasLayoutMutation } from '../src/frame-mutations.mjs';

test('responsive no-op and reverted class writes do not trigger another frame resize', () => {
  const target = { getAttribute: () => 'sidebar' };
  const mutation = oldValue => ({ type: 'attributes', target, attributeName: 'class', oldValue });
  assert.equal(hasLayoutMutation([mutation('sidebar')]), false);
  assert.equal(hasLayoutMutation([mutation('sidebar'), mutation('sidebar open')]), false);
  assert.equal(hasLayoutMutation([mutation(null)]), true);
  assert.equal(hasLayoutMutation([mutation('sidebar open')]), true);
});

test('real content, text and attribute changes still remeasure the document', () => {
  const target = { getAttribute: name => name === 'class' ? 'sidebar' : 'height:200px' };
  assert.equal(hasLayoutMutation([
    { type: 'attributes', target, attributeName: 'class', oldValue: 'sidebar' },
    { type: 'attributes', target, attributeName: 'style', oldValue: 'height:400px' },
  ]), true);
  assert.equal(hasLayoutMutation([{ type: 'characterData', target: { data: 'updated' }, oldValue: 'original' }]), true);
  assert.equal(hasLayoutMutation([{ type: 'characterData', target: { data: 'same' }, oldValue: 'same' }]), false);
  assert.equal(hasLayoutMutation([{ type: 'childList', addedNodes: [{}], removedNodes: [] }]), true);
  assert.equal(hasLayoutMutation([{ type: 'childList', addedNodes: [], removedNodes: [{}] }]), true);
});
