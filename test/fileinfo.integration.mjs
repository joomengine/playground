import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { PhpCgiNode } from 'php-cgi-wasm/PhpCgiNode.mjs';
import { stageFileinfo } from '../scripts/fileinfo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
const directory = path.resolve(root, process.env.FILEINFO_EXTENSION_DIR || '.cache/fileinfo');
for (const version of pins.php) {
  test(`PHP ${version.version}: verified fileinfo identifies MIME types with its embedded magic database`, { timeout: 60_000 }, async t => {
    const destination = await mkdtemp(path.join(tmpdir(), 'playground-fileinfo-'));
    t.after(() => rm(destination, { recursive: true, force: true }));
    const record = await stageFileinfo({ directory, destination, version, upstream: pins.upstream });
    const php = new PhpCgiNode({ version: version.version, persist: [], docroot: '/www', prefix: '/',
      sharedLibs: [{ name: record.provenance.extension.file, url: pathToFileURL(path.join(destination, record.provenance.extension.file)).href, ini: true }],
      ini: 'display_errors=1\n',
    });
    await php.mkdir('/config');
    await php.mkdir('/www');
    await php.writeFile('/www/index.php', `<?php
      $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=');
      file_put_contents('/tmp/proof.png', $png);
      $info = new finfo(FILEINFO_MIME_TYPE);
      echo json_encode(['php' => PHP_VERSION, 'intSize' => PHP_INT_SIZE, 'loaded' => extension_loaded('fileinfo'),
        'version' => phpversion('fileinfo'), 'png' => $info->buffer($png), 'file' => $info->file('/tmp/proof.png'),
        'legacy' => mime_content_type('/tmp/proof.png'), 'text' => $info->buffer('Hello Joomla!'),
        'pdf' => $info->buffer("%PDF-1.7\\n")], JSON_THROW_ON_ERROR);
    `);
    const response = await php.request({ url: '/index.php', method: 'GET', headers: { host: 'localhost' } });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.deepEqual(JSON.parse(body), { php: version.patchVersion, intSize: 4, loaded: true, version: version.patchVersion,
      png: 'image/png', file: 'image/png', legacy: 'image/png', text: 'text/plain', pdf: 'application/pdf' });
  });
}
