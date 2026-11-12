import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredValue } from '../src/structured-inputs.mjs';

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
  for (let index = 0; index < 18; index++) { parent.child = {}; parent = parent.child; }
  assert.throws(() => structuredValue(nested), /too complex/);
});
