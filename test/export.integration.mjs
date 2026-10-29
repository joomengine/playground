import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';

test('actual MariaDB export rejects ambiguous CTEs and preserves historical tables by refusing export', { timeout: 120_000 }, async () => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.4' });
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

test('large binary rows and byte-bounded batches round-trip through the portable statement stream', { timeout: 120_000 }, async () => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.5' });
  try {
    await runtime.fs.writeFile('/tmp/export.php', await readFile(new URL('../src/export/site.php', import.meta.url), 'utf8'));
    const result = await runtime.runPhp(`<?php
      $exportOptions = ['operation'=>'cleanup','directory'=>'/tmp/joomengine-export-00000000-0000-0000-0000-000000000000'];
      ob_start(); require '/tmp/export.php'; ob_end_clean();
      class JConfig { public $db='joomla'; public $user='root'; public $password=''; public $dbprefix='jml_'; }
      $connect = static fn () => new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
      $proof = 'SELECT id,OCTET_LENGTH(body) AS bytes,SHA2(body,256) AS digest,label,optional,HEX(flags) AS flags,ST_AsText(coordinates) AS coordinates,ST_SRID(coordinates) AS srid FROM payload ORDER BY id';
      $db = $connect();
      $db->exec('CREATE TABLE payload (id INT PRIMARY KEY, body LONGBLOB, label VARCHAR(64), optional TEXT NULL, flags BIT(10), coordinates POINT NULL)');
      $db->exec("INSERT INTO payload VALUES (1,REPEAT(X'0001ff80',786432),'Afrikaans — 中文',NULL,b'1010101010',ST_GeomFromText('POINT(1 2)',4326))");
      $db->exec("INSERT INTO payload VALUES (2,REPEAT(X'0080feff',3407872),'large','',b'1',NULL)");
      for ($id = 3; $id <= 22; ++$id) $db->exec("INSERT INTO payload VALUES ($id,REPEAT(X'0061ff62',16384),'batch','value',b'0',ST_GeomFromText('POINT(3 4)',0))");
      $db->exec("INSERT INTO payload VALUES (23,X'','empty','',b'0',NULL)");
      $before = $db->query($proof)->fetchAll(PDO::FETCH_ASSOC);
      $db = null;
      mkdir('/tmp/large-export');
      $metadata = exportDatabase(new JConfig(), '/tmp/large-export/database.sql');
      $db = $connect();
      $stream = fopen('/tmp/large-export/database.ndjson', 'rb');
      $maximum = 0;
      $chunks = 0;
      while (($line = fgets($stream, PLAYGROUND_EXPORT_STATEMENT_BYTES * 2)) !== false) {
        $statement = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
        $maximum = max($maximum, strlen($statement));
        if (str_starts_with($statement, 'SET @__joomengine_export_') && str_contains($statement, '=CONCAT(')) ++$chunks;
        $db->exec($statement);
      }
      fclose($stream);
      $after = $db->query($proof)->fetchAll(PDO::FETCH_ASSOC);
      $cleared = $db->query('SELECT @__joomengine_export_0 IS NULL AND @__joomengine_export_1 IS NULL')->fetchColumn();
      $guardStreams = ['sql'=>fopen('php://temp','w+b'),'ndjson'=>fopen('php://temp','w+b')];
      $guardBytes = 0;
      exportPacketGuard($guardStreams, PHP_INT_MAX, $guardBytes);
      rewind($guardStreams['ndjson']);
      $packetError = null;
      try {
        while (($line = fgets($guardStreams['ndjson'])) !== false) $db->exec(json_decode($line, true, 512, JSON_THROW_ON_ERROR));
      } catch (PDOException $error) { $packetError = $error->getMessage(); }
      foreach ($guardStreams as $stream) fclose($stream);
      echo json_encode(['before'=>$before,'after'=>$after,'rows'=>$metadata['rows'],'largestValueBytes'=>$metadata['largestValueBytes'],'maximum'=>$maximum,'chunks'=>$chunks,'cleared'=>(bool)$cleared,'packetError'=>$packetError], JSON_THROW_ON_ERROR);
    `);
    assert.equal(result.status, 200, result.text.slice(0, 2000));
    const report = JSON.parse(result.text);
    assert.deepEqual(report.after, report.before, 'Binary values, nulls, empty strings, bit columns and spatial values must survive export/import.');
    assert.equal(report.rows, 23);
    assert.equal(report.before[0].bytes, 3 * 1024 * 1024);
    assert.equal(report.before[1].bytes, 13 * 1024 * 1024);
    assert.equal(report.largestValueBytes, 13 * 1024 * 1024);
    assert.ok(report.maximum < 1024 * 1024, `A statement grew to ${report.maximum} bytes.`);
    assert.ok(report.chunks >= 128, 'Large values must be replayed in bounded chunks.');
    assert.equal(report.cleared, true, 'The importer must not retain large temporary SQL values.');
    assert.match(report.packetError, /SQLSTATE\[45000\].*max_allowed_packet/, 'A destination with an insufficient packet limit must fail before silently replacing a large value with NULL.');
  } finally {
    await runtime.close();
  }
});
