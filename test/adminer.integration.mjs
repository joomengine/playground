import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { prepareAdminer } from '../scripts/prepare-adminer.mjs';

// Exercise the real upstream PHP and embedded MariaDB, not a substitute SQL stub.
// The browser test additionally covers the private virtual route and panel lifecycle.
test('Adminer browses and modifies the active MariaDB with CSRF protection and exact exports', { timeout: 120_000 }, async t => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: process.env.PHP_VERSION || '8.4' });
  t.after(() => runtime.close());
  const prepared = await prepareAdminer();
  await runtime.fs.mkdir('/internal/adminer');
  await runtime.fs.writeFile('/internal/adminer/adminer.php', prepared.source);
  await runtime.fs.writeFile('/internal/adminer/index.php', await readFile(new URL('../src/database/index.php', import.meta.url)));
  await runtime.fs.writeFile('/persist/www/configuration.php', "<?php class JConfig { public $db = 'joomla'; }");
  await runtime.fs.writeFile('/persist/www/database-test.php', "<?php require '/internal/adminer/index.php';");
  const setup = await runtime.runPhp(`<?php
    $pdo = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
    $pdo->exec('CREATE TABLE adminer_contract (id INT PRIMARY KEY, value VARCHAR(255))');
    $pdo->exec("INSERT INTO adminer_contract VALUES (1, 'original café 🦁')");
    echo 'ready';
  `);
  assert.equal(setup.text, 'ready');
  const overview = await runtime.request('/database-test.php');
  const overviewHtml = await overview.text();
  assert.equal(overview.status, 200, overviewHtml);
  assert.match(overviewHtml, /adminer_contract/);
  assert.doesNotMatch(overviewHtml, /registration\.unregister|partial\(verifyVersion/);
  assert.equal(overview.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(overview.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const browse = await runtime.request('/database-test.php?select=adminer_contract');
  const browseHtml = await browse.text();
  assert.equal(browse.status, 200, browseHtml);
  assert.match(browseHtml, /original café 🦁/);

  const command = await runtime.request('/database-test.php?sql=');
  const commandHtml = await command.text();
  const token = commandHtml.match(/name=['"]token['"] value=['"]([^'"]+)/)?.[1];
  assert.ok(token, 'Adminer must issue its own CSRF token.');
  const post = async (query, csrf = token, extra = {}) => runtime.request('/database-test.php?sql=', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query, token: csrf, limit: '50', ...extra }).toString(),
  });
  const refused = await post("UPDATE adminer_contract SET value='forged' WHERE id=1", 'invalid');
  assert.equal(refused.status, 403);
  const update = await post("UPDATE adminer_contract SET value='updated café 🦁' WHERE id=1; INSERT INTO adminer_contract VALUES (2,'second'); SELECT * FROM adminer_contract;");
  const updatedHtml = await update.text();
  assert.equal(update.status, 200, updatedHtml);
  assert.match(updatedHtml, /updated café 🦁/);
  assert.doesNotMatch(updatedHtml, /class=['"]error['"]/);
  const proof = await runtime.runPhp(`<?php
    $pdo = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
    echo json_encode($pdo->query('SELECT * FROM adminer_contract ORDER BY id')->fetchAll(PDO::FETCH_ASSOC), JSON_UNESCAPED_UNICODE);
  `);
  assert.deepEqual(JSON.parse(proof.text), [{ id: 1, value: 'updated café 🦁' }, { id: 2, value: 'second' }]);
  const exported = await post('SELECT * FROM adminer_contract ORDER BY id', token, { export: '1', format: 'csv', output: 'file' });
  const csv = await exported.text();
  assert.equal(exported.status, 200, csv);
  assert.match(csv, /updated café 🦁/);
  assert.doesNotMatch(csv, /__adminer|__public-assets/);
  const forgedLogin = await runtime.request('/database-test.php', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'auth[server]=external.invalid&auth[username]=someone',
  });
  assert.equal(forgedLogin.status, 400);
});
