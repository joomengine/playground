import assert from 'node:assert/strict';
import test from 'node:test';
import { builtWrapper, releasedLibraries } from './runtime-artifacts.mjs';
import { configurePhpRouting } from '../src/php-routing.mjs';

test('native CGI routes existing PHP script suffixes and resets PATH_INFO', { timeout: 30_000 }, async () => {
  const { PhpCgiNode } = await builtWrapper('8.4');
  const php = new PhpCgiNode({ sharedLibs: await releasedLibraries('8.4'), version: '8.4', docroot: '/www', prefix: '/site/', persist: [], staticFS: true });
  const binary = await php.binary;
  configurePhpRouting(php, binary);
  for (const directory of ['/config', '/www/api', '/www/folder.php']) binary.FS.mkdirTree(directory);
  binary.FS.writeFile('/www/index.php', '<?php echo "root";');
  binary.FS.writeFile('/www/api/index.php', `<?php echo json_encode([
    'script' => $_SERVER['SCRIPT_NAME'], 'file' => $_SERVER['SCRIPT_FILENAME'],
    'path' => $_SERVER['PATH_INFO'] ?? '', 'uri' => $_SERVER['REQUEST_URI'],
    'query' => $_GET, 'method' => $_SERVER['REQUEST_METHOD'], 'body' => file_get_contents('php://input'),
  ], JSON_THROW_ON_ERROR);`);
  binary.FS.writeFile('/www/folder.php/file.php', '<?php echo "directory";');
  php.initialized = true;
  const request = (url, init = {}) => php.request({ url: `/site/${url}`, method: 'GET', headers: { host: 'localhost' }, ...init });
  const response = await request('api/index.php/v1/items?filter=active', {
    method: 'POST', headers: { host: 'localhost', 'Content-Type': 'application/json' },
    body: new Blob(['{"item":7}']).stream(),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    script: '/site/api/index.php', file: '/www/api/index.php', path: '/v1/items',
    uri: '/site/api/index.php/v1/items?filter=active', query: { filter: 'active' },
    method: 'POST', body: '{"item":7}',
  });
  assert.equal((await (await request('api/index.php')).json()).path, '');
  assert.equal(await (await request('folder.php/file.php')).text(), 'directory');
  assert.equal(await (await request('missing.php/items')).text(), 'root');
});
