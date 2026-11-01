import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadFailure, packageLabel } from '../src/provisioning-errors.mjs';

test('package labels do not expose source URLs or internal asset paths', () => {
  for (const source of [undefined, 'https://example.org/extension.zip?token=private', '/assets/packages/internal-name.zip']) {
    assert.equal(packageLabel(source), 'Extension package');
  }
});

test('download diagnostics distinguish cancellation, timeout and transport failures', () => {
  assert.equal(downloadFailure(new DOMException('aborted', 'AbortError')), 'Download cancelled.');
  assert.equal(downloadFailure(new DOMException('deadline', 'TimeoutError')), 'The download timed out. Try again.');
  const message = downloadFailure(new TypeError('Failed to fetch'));
  assert.equal(message, 'The download could not be completed. Check your connection and try again.');
  assert.doesNotMatch(message, /CORS|host|HTTP/);
  assert.equal(downloadFailure(new Error('HTTP 404.')), 'HTTP 404.');
});

