import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';

test('import refreshes actual MariaDB base-table index statistics and skips views', { timeout: 120_000 }, async () => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
  try {
    await runtime.fs.writeFile('/tmp/import.php', await readFile(new URL('../src/joomla/php/import.php', import.meta.url), 'utf8'));
    const result = await runtime.runPhp(`<?php
      function playgroundRoot(array $options): string { throw new RuntimeException('Load import helpers only.'); }
      function playgroundFinish(array $result): void {}
      $playground = [];
      require '/tmp/import.php';
      $db = new PDO('mysql:dbname=joomla', 'root', '', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
      $db->exec('CREATE TABLE \x60seed\x60\x60rows\x60 (id INT PRIMARY KEY, guid VARCHAR(36), KEY idx_guid(guid))');
      $db->exec('SET autocommit=0');
      for ($id=1; $id<=100; ++$id) $db->exec("INSERT INTO \x60seed\x60\x60rows\x60 VALUES ($id, 'guid-$id')");
      $db->exec('COMMIT');
      $db->exec('CREATE VIEW seed_view AS SELECT id FROM \x60seed\x60\x60rows\x60');
      playgroundRefreshImportedStatistics($db);
      $indexes = $db->query('SHOW INDEX FROM \x60seed\x60\x60rows\x60')->fetchAll(PDO::FETCH_ASSOC);
      echo json_encode(['indexes'=>$indexes,'rows'=>(int)$db->query('SELECT COUNT(*) FROM seed_view')->fetchColumn()]);
    `);
    assert.equal(result.status, 200, result.text);
    const report = JSON.parse(result.text);
    assert.equal(report.rows, 100);
    assert.ok(report.indexes.find(index => index.Key_name === 'idx_guid').Cardinality > 1,
      'The imported index must expose its distinct keys instead of retaining empty-table cardinality.');
  } finally {
    await runtime.close();
  }
});
