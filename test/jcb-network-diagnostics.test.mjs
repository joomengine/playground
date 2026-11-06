import assert from 'node:assert/strict';
import test from 'node:test';
import { jcbDiagnosticText } from './jcb-network-diagnostics.mjs';

test('JCB failure diagnostics retain PHP errors while removing credentials and private URL fields', () => {
  const result = jcbDiagnosticText('PHP Fatal error: Maximum execution time of 60 seconds exceeded\n'
    + 'test-login-value\nAuthorization: Bearer private-token\nCookie: session=private-cookie\n'
    + 'https://user:password@example.test/path?token=private-query#private-fragment\npassword="private-password"', ['test-login-value']);
  assert.match(result, /Maximum execution time of 60 seconds exceeded/);
  assert.match(result, /https:\/\/example.test\/path/);
  assert.doesNotMatch(result, /test-login-value|private-|user:password/);
});

test('JCB diagnostics are bounded and preserve a supplied log tail', () => {
  const source = 'earlier entry\n'.repeat(1000) + 'RuntimeException: failed repository read';
  const result = jcbDiagnosticText(source.slice(-4096), [], 4096);
  assert.ok(result.length <= 4096);
  assert.match(result, /RuntimeException: failed repository read$/);
  assert.ok(jcbDiagnosticText('x'.repeat(20000)).length <= 8192);
});
