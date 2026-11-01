import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { builtWrapper, builtRuntimeDirectory, builtManifest, releasedLibraries } from './runtime-artifacts.mjs';
import { phpIni } from '../src/php-settings.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'rocket-cgi-'));
const pins = await builtManifest();
const selected = process.env.PLAYGROUND_PHP_VERSIONS?.split(',');
const preload = path.join(temporary, 'preload-ready.php');
await writeFile(preload, '<?php return "preload complete";');

test('staged int64 CGI carries binary API bodies and multipart uploads', { timeout: 180_000 }, async t => {
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const version of pins.php.filter(value => !selected || selected.includes(value.version))) {
    await t.test(`PHP ${version.version} request methods and effective settings`, async () => {
      const { PhpCgiNode } = await builtWrapper(version.version);
      const original = await builtRuntimeDirectory(version.version);
      const php = new PhpCgiNode({ sharedLibs: await releasedLibraries(version.version), version: version.version, persist: [], docroot: '/www', prefix: '/',
        locateFile: name => name === preload ? name : path.join(original, path.basename(name)), ini: phpIni(),
        files: [{ parent: '/internal', name: 'preload-ready.php', url: preload }],
      });
      const initialized = await php.binary;
      assert.equal(initialized.FS.readFile('/internal/preload-ready.php', { encoding: 'utf8' }), '<?php return "preload complete";',
        'Initialization must wait until asynchronous preload files exist.');
      await php.mkdir('/config'); await php.mkdir('/www'); await php.mkdir('/persist'); await php.mkdir('/persist/sessions');
      await php.writeFile('/www/index.php', `<?php
        header('Content-Type: application/json'); $body = file_get_contents('php://input');
        echo json_encode(['method' => $_SERVER['REQUEST_METHOD'], 'length' => strlen($body), 'hash' => hash('sha256', $body),
          'type' => $_SERVER['CONTENT_TYPE'] ?? '', 'post' => $_POST,
          'file' => isset($_FILES['package']) ? ['size' => $_FILES['package']['size'], 'error' => $_FILES['package']['error'], 'hash' => hash_file('sha256', $_FILES['package']['tmp_name'])] : null,
          'ini' => ['upload' => ini_get('upload_max_filesize'), 'post' => ini_get('post_max_size'), 'memory' => ini_get('memory_limit'), 'time' => ini_get('max_execution_time')]], JSON_THROW_ON_ERROR);
      `);
      const request = async (method, body, type = 'application/octet-stream') => {
        const response = await php.request({ url: '/index.php', method,
          headers: new Map([['host', 'localhost'], ['Content-Type', type]]), body: body == null ? null : new Blob([body]).stream() });
        const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
      };
      const binary = new Uint8Array([0, 255, 128, 127, ...new TextEncoder().encode('Joomla — 中文')]);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const result = await request(method, binary);
        assert.equal(result.method, method); assert.equal(result.length, binary.length);
        assert.equal(result.hash, createHash('sha256').update(binary).digest('hex'));
        assert.equal(result.type, 'application/octet-stream');
        assert.deepEqual(result.ini, { upload: '128M', post: '160M', memory: '512M', time: '60' });
      }
      const form = await request('POST', 'name=Afrikaans&value=%E4%B8%AD%E6%96%87', 'application/x-www-form-urlencoded');
      assert.deepEqual(form.post, { name: 'Afrikaans', value: '中文' });
      const clean = await request('GET'); assert.equal(clean.length, 0); assert.equal(clean.method, 'GET');
      if (version.version === '8.4') {
        const size = process.env.PLAYGROUND_LARGE_UPLOAD === '1' ? 128 * 1024 * 1024 : 1024 * 1024;
        const content = new Uint8Array(size); content.fill(165); content[0] = 0; content[size - 1] = 255;
        const data = new FormData(); data.append('package', new Blob([content]), 'component.zip'); data.append('name', 'JCB');
        const encoded = new Request('https://example.test/', { method: 'POST', body: data });
        const result = await request('POST', await encoded.arrayBuffer(), encoded.headers.get('Content-Type'));
        assert.equal(result.file.error, 0); assert.equal(result.file.size, size);
        assert.equal(result.file.hash, createHash('sha256').update(content).digest('hex'));
        assert.deepEqual(result.post, { name: 'JCB' });
      }
    });
  }
  await t.test('a missing preload rejects initialization with its file context', async () => {
    const missing = path.join(temporary, 'missing-preload.php');
    const version = pins.php.at(-1).version;
    const { PhpCgiNode } = await builtWrapper(version);
    const original = await builtRuntimeDirectory(version);
    const php = new PhpCgiNode({ sharedLibs: await releasedLibraries(version), version, persist: [],
      locateFile: name => name === missing ? name : path.join(original, path.basename(name)),
      files: [{ parent: '/internal', name: 'missing-preload.php', url: missing }],
    });
    await assert.rejects(php.binary, /Unable to preload \/internal\/missing-preload\.php:/);
  });
});
