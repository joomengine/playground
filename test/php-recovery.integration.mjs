import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { repairJoomlaConfiguration } from '../src/joomla/index.mjs';

test('PHP application failure preserves its response and files, then accepts another request', { timeout: 90_000 }, async t => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.5' });
  t.after(() => runtime.close());
  await runtime.fs.writeFile('/persist/www/failure.php', `<?php
    ini_set('display_errors', '1');
    file_put_contents('/persist/www/saved.txt', 'saved before failure');
    throw new RuntimeException('Recoverable application failure');
  `);
  await runtime.fs.writeFile('/persist/www/next.php', `<?php
    header('Content-Type: application/json');
    echo json_encode(['saved' => file_get_contents('/persist/www/saved.txt'), 'answer' => 42]);
  `);
  const failure = await runtime.request('failure.php');
  const output = await failure.text();
  assert.equal(failure.status, 500, output);
  assert.match(output, /Recoverable application failure/);
  const next = await runtime.request('next.php');
  assert.equal(next.status, 200);
  assert.deepEqual(await next.json(), { saved: 'saved before failure', answer: 42 });
  assert.equal(new TextDecoder().decode(await runtime.fs.readFile('/persist/www/saved.txt')), 'saved before failure');

  const original = `<?php class JConfig {
    public $debug = 1;
    public $error_reporting = 'maximum';
    public $sitename = 'Keep my site';
    public $password = 'unchanged-private-value';
  }
  throw new RuntimeException('Recovery must not execute configuration.php');`;
  await runtime.fs.writeFile('/persist/www/configuration.php', original);
  const sourceLoader = name => readFile(new URL(`../src/joomla/php/${name}.php`, import.meta.url), 'utf8');
  const result = await repairJoomlaConfiguration(runtime, { sourceLoader });
  assert.equal(result.debug, false);
  assert.equal(result.errorReporting, 'default');
  assert.equal(new TextDecoder().decode(await runtime.fs.readFile(result.backup)), original);
  const repaired = new TextDecoder().decode(await runtime.fs.readFile('/persist/www/configuration.php'));
  assert.equal(repaired, original.replace('$debug = 1', '$debug = false').replace("$error_reporting = 'maximum'", "$error_reporting = 'default'"));
});
