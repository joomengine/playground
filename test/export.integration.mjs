import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';

test('actual MariaDB export rejects ambiguous CTEs and preserves historical tables by refusing export', { timeout: 120_000 }, async () => {
  const runtime = await createNodeRuntime({ phpVersion: '8.4' });
  try {
    await runtime.fs.writeFile('/tmp/export.php', await readFile(new URL('../src/export/site.php', import.meta.url), 'utf8'));
    const result = await runtime.runPhp(`<?php
      $exportOptions = ['operation'=>'cleanup','directory'=>'/tmp/joomengine-export-00000000-0000-0000-0000-000000000000'];
      ob_start(); require '/tmp/export.php'; ob_end_clean();
      class JConfig { public $db='joomla'; public $user='root'; public $password=''; public $dbprefix='jml_'; }
      $connect = static fn () => new PDO('mysql:dbname=joomla', 'root', '', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
      $db = $connect();
      $db->exec('CREATE TABLE a (id INT PRIMARY KEY)');
      $db->exec('CREATE TABLE b (id INT PRIMARY KEY)');
      $db->exec('INSERT INTO a VALUES (1)');
      $db->exec('INSERT INTO b VALUES (1)');
      $db->exec("CREATE TABLE literal_test (value VARCHAR(64) DEFAULT 'WITH SYSTEM VERSIONING')");
      $db->exec('CREATE VIEW cte_view AS WITH joomla AS (SELECT id FROM a) SELECT joomla.id AS left_id,b.id AS right_id FROM joomla JOIN b ON joomla.id=b.id');
      $viewRows = $db->query('SELECT * FROM cte_view')->fetchAll(PDO::FETCH_ASSOC);
      $db = null;
      mkdir('/tmp/cte-export');
      $cteError = null;
      try { exportDatabase(new JConfig(), '/tmp/cte-export/database.sql'); }
      catch (RuntimeException $error) { $cteError = $error->getMessage(); }
      $db = $connect();
      $db->exec('DROP VIEW cte_view');
      $db->exec('CREATE TABLE historical (id INT PRIMARY KEY, value INT) WITH SYSTEM VERSIONING');
      $db->exec('INSERT INTO historical VALUES (1,10)');
      $db->exec('UPDATE historical SET value=20 WHERE id=1');
      $before = $db->query('SELECT id,value FROM historical FOR SYSTEM_TIME ALL ORDER BY value')->fetchAll(PDO::FETCH_ASSOC);
      $db = null;
      mkdir('/tmp/history-export');
      $historyError = null;
      try { exportDatabase(new JConfig(), '/tmp/history-export/database.sql'); }
      catch (RuntimeException $error) { $historyError = $error->getMessage(); }
      $db = $connect();
      $after = $db->query('SELECT id,value FROM historical FOR SYSTEM_TIME ALL ORDER BY value')->fetchAll(PDO::FETCH_ASSOC);
      $db->exec('DROP TABLE historical');
      $db = null;
      mkdir('/tmp/ordinary-export');
      $ordinary = exportDatabase(new JConfig(), '/tmp/ordinary-export/database.sql');
      echo json_encode(['viewRows'=>$viewRows,'cteError'=>$cteError,'before'=>$before,'after'=>$after,'historyError'=>$historyError,'ordinaryRows'=>$ordinary['rows']], JSON_THROW_ON_ERROR);
    `);
    assert.equal(result.status, 200, result.text.slice(0, 1000));
    const report = JSON.parse(result.text);
    assert.deepEqual(report.viewRows, [{ left_id: 1, right_id: 1 }]);
    assert.match(report.cteError, /common table expression conflicts/);
    assert.deepEqual(report.before, [{ id: 1, value: 10 }, { id: 1, value: 20 }]);
    assert.match(report.historyError, /system-versioned tables/);
    assert.deepEqual(report.after, report.before);
    assert.equal(report.ordinaryRows, 2);
  } finally {
    await runtime.close();
  }
});
