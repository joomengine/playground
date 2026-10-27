import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PhpNode } from 'php-wasm/PhpNode.mjs';
import { normalizeExportOptions } from '../src/export.mjs';

test('portable export validates formats and destination settings', () => {
  assert.equal(normalizeExportOptions().format, 'bundle');
  assert.deepEqual(normalizeExportOptions({ format: 'files', database: { name: 'destination', password: '' } }), {
    format: 'files', database: { name: 'destination', password: '' },
  });
  assert.throws(() => normalizeExportOptions({ format: 'unknown' }), /format/);
  assert.throws(() => normalizeExportOptions({ database: { unexpected: 'value' } }), /Unknown/);
  assert.throws(() => normalizeExportOptions({ database: { password: 'secret\0text' } }), /Invalid/);
});

test('actual PHP exporter preserves quoted SQL while normalizing portable DDL', { timeout: 120_000 }, async () => {
  const php = new PhpNode({ version: '8.4', persist: [] });
  let output = '';
  let errors = '';
  php.addEventListener('output', (event) => { output += event.detail.join(''); });
  php.addEventListener('error', (event) => { errors += event.detail.join(''); });
  await php.writeFile('/export.php', await readFile(new URL('../src/export/site.php', import.meta.url), 'utf8'));
  const result = await php.run(`<?php
    $exportOptions = ['operation'=>'cleanup','directory'=>'/tmp/joomengine-export-00000000-0000-0000-0000-000000000000'];
    ob_start(); require '/export.php'; ob_end_clean();
    $view = "CREATE ALGORITHM=UNDEFINED DEFINER=\x60root\x60@\x60localhost\x60 SQL SECURITY DEFINER VIEW \x60second_view\x60 AS SELECT \x60joomla\x60.\x60first_view\x60.\x60id\x60 AS \x60id\x60, 'joomla.first_view; DEFINER=root' AS \x60label\x60 FROM \x60joomla\x60.\x60first_view\x60";
    $portable = exportPortableDdl($view, 'joomla', 'VIEW', '', ['first_view','second_view']);
    $trigger = exportPortableDdl("CREATE DEFINER='root'@'localhost' TRIGGER \x60counter\x60 BEFORE UPDATE ON \x60joomla\x60.\x60items\x60 FOR EACH ROW SET NEW.hits=OLD.hits+1", 'joomla', 'TRIGGER', '', []);
    $rejected = false;
    try { exportPortableDdl('CREATE TRIGGER counter BEFORE UPDATE ON items FOR EACH ROW BEGIN SET NEW.hits=1; SET NEW.title=2; END', 'joomla', 'TRIGGER', '', []); }
    catch (RuntimeException $error) { $rejected = str_contains($error->getMessage(), 'Compound'); }
    $crossDatabaseRejected = false;
    try { exportPortableDdl('CREATE VIEW sample AS SELECT a.id FROM joomla.items a, external.items b WHERE a.id=b.id', 'joomla', 'VIEW', '', []); }
    catch (RuntimeException $error) { $crossDatabaseRejected = str_contains($error->getMessage(), 'Cross-database'); }
    $cteRejected = 0;
    foreach ([
      'CREATE VIEW sample AS WITH joomla AS (SELECT id FROM a) SELECT joomla.id,b.id FROM joomla JOIN b ON joomla.id=b.id',
      'CREATE VIEW sample AS WITH first AS (SELECT id FROM a), joomla (id) AS (SELECT id FROM first) SELECT joomla.id,b.id FROM joomla JOIN b ON joomla.id=b.id',
    ] as $definition) {
      try { exportPortableDdl($definition, 'joomla', 'VIEW', '', []); }
      catch (RuntimeException $error) { if (str_contains($error->getMessage(), 'common table expression')) ++$cteRejected; }
    }
    class JConfig { public $host='localhost'; public $user='root'; public $password=''; public $db='joomla'; public $log_path='/persist/www/administrator/logs'; public $tmp_path='/persist/www/tmp'; public $session_handler='filesystem'; public $session_filesystem_path='/persist/sessions'; }
    $configuration = exportConfiguration(new JConfig(), ['name'=>'destination','user'=>'site_owner','password'=>"a'b\\\\c"]);
    token_get_all($configuration, TOKEN_PARSE);
    echo json_encode(['view'=>$portable,'trigger'=>$trigger,'compoundRejected'=>$rejected,'crossDatabaseRejected'=>$crossDatabaseRejected,'cteRejected'=>$cteRejected,'configuration'=>$configuration], JSON_THROW_ON_ERROR);
  `);
  assert.equal(result, 0, `${errors}\n${output}`);
  assert.equal(errors, '');
  const value = JSON.parse(output);
  assert.deepEqual(value.view.dependencies, ['first_view']);
  assert.match(value.view.sql, /DEFINER=CURRENT_USER SQL SECURITY DEFINER/);
  assert.match(value.view.sql, /'joomla\.first_view; DEFINER=root'/);
  assert.doesNotMatch(value.view.sql, /`joomla`\./);
  assert.match(value.trigger.sql, /ON `items` FOR EACH ROW SET NEW\.hits=OLD\.hits\+1/);
  assert.equal(value.compoundRejected, true);
  assert.equal(value.crossDatabaseRejected, true);
  assert.equal(value.cteRejected, 2);
  assert.match(value.configuration, /public \$db = 'destination'/);
  assert.match(value.configuration, /__DIR__ \. '\/administrator\/logs'/);
  assert.match(value.configuration, /session_handler = 'database'/);
  assert.doesNotMatch(value.configuration, /\/persist/);
  await php.refresh();
});
