import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PHP_SETTINGS, normalizePhpSettings, phpIni, phpRequestBodyLimit, phpRequestTimeoutMs } from '../src/php-settings.mjs';
import { breakoutRequest } from '../src/cgi-request.mjs';

test('PHP settings preserve JCB headroom and validate correlated limits', () => {
  assert.deepEqual(normalizePhpSettings(), DEFAULT_PHP_SETTINGS);
  const value = normalizePhpSettings({ upload_max_filesize: 128, post_max_size: '160MiB', memory_limit: '256m', max_input_vars: '7000' });
  assert.equal(value.upload_max_filesize, '128M');
  assert.equal(value.memory_limit, '256M');
  assert.equal(value.max_input_vars, 7000);
  assert.equal(phpRequestBodyLimit(value), 160 * 1024 * 1024);
  assert.equal(phpRequestTimeoutMs(value), 180_000);
  assert.match(phpIni(value), /memory_limit=256M\n/);
  for (const settings of [{ post_max_size: '128M' }, { memory_limit: '128M' }, { upload_max_filesize: '2G' }, { memory_limit: -1 },
    { max_execution_time: 0 }, { max_input_time: '60\nfoo=1' }, { max_input_vars: 7000.5 }, { auto_prepend_file: '/evil.php' }]) {
    assert.throws(() => normalizePhpSettings(settings));
  }
});

test('CGI decoder preserves binary methods, Unicode, content type and empty requests', async () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255, ...new TextEncoder().encode('Afrikaans 中文 Ελληνικά')]);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const value = await breakoutRequest(new Request('https://example.test/api?limit=7', {
      method, body: bytes, headers: { 'Content-Type': 'application/octet-stream' },
    }));
    assert.deepEqual(value.post, bytes);
    assert.equal(value.method, method);
    assert.equal(value.get, 'limit=7');
    assert.equal(value.contentType, 'application/octet-stream');
  }
  assert.equal((await breakoutRequest(new Request('https://example.test/'))).post.byteLength, 0);
  await assert.rejects(breakoutRequest(new Request('https://example.test/', { method: 'POST', headers: { 'Content-Length': '9999999999' } })), /body limit/);
  const failed = new ReadableStream({ start(controller) { controller.error(new Error('transfer interrupted')); } });
  await assert.rejects(breakoutRequest({ url: 'https://example.test/', method: 'PATCH', body: failed }), /transfer interrupted/);
});
