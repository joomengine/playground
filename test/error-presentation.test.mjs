import assert from 'node:assert/strict';
import test from 'node:test';
import { presentError } from '../src/error-presentation.mjs';

test('installation failures retain a short summary with bounded private technical details', () => {
  const error = Object.assign(new Error('Package installation exceeded PHP’s 180-second limit.'), {
    technicalDetails: '<!doctype html><style>body{color:red}</style> password="private-value" ' + 'x'.repeat(12000),
    phase: 'installation', packageUrl: 'https://user:pass@example.test/package.zip?token=private-value',
    executionTimeSeconds: 180, timeoutMs: 210000,
  });
  const result = presentError(error, { secrets: ['private-value'] });
  assert.equal(result.summary, error.message);
  assert.match(result.details, /Installation allowance: 180 seconds/);
  assert.match(result.details, /Host deadline: 210 seconds/);
  assert.doesNotMatch(result.details, /private-value|user:pass|token=/);
  assert.ok(result.details.length <= 8192);
});

test('unstructured runtime documents are only available as technical details', () => {
  const result = presentError(new Error('Invalid response: <!DOCTYPE html><style>body{margin:0}</style>'));
  assert.doesNotMatch(result.summary, /DOCTYPE|style|margin/);
  assert.match(result.details, /DOCTYPE/);
  assert.equal(presentError(new Error('Package download failed.')).summary, 'Package download failed.');
});
