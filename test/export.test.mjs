import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PhpNode } from 'php-wasm/PhpNode.mjs';
import { exportPlaygroundConfiguration, normalizeExportOptions } from '../src/export.mjs';

test('portable export validates formats and destination settings', () => {
  assert.equal(normalizeExportOptions().format, 'bundle');
  assert.deepEqual(normalizeExportOptions({ format: 'files', database: { name: 'destination', password: '' } }), {
    format: 'files', database: { name: 'destination', password: '' },
  });
  assert.throws(() => normalizeExportOptions({ format: 'unknown' }), /format/);
  assert.throws(() => normalizeExportOptions({ database: { unexpected: 'value' } }), /Unknown/);
  assert.throws(() => normalizeExportOptions({ database: { password: 'secret\0text' } }), /Invalid/);
  assert.equal(normalizeExportOptions({ includePlaygroundConfiguration: true }).includePlaygroundConfiguration, true);
  assert.equal(normalizeExportOptions({ format: 'files', includePlaygroundConfiguration: true }).includePlaygroundConfiguration, undefined);
  assert.equal(normalizeExportOptions({ format: 'database', includePlaygroundConfiguration: true }).includePlaygroundConfiguration, undefined);
  assert.throws(() => normalizeExportOptions({ includePlaygroundConfiguration: 'yes' }), /boolean/);
});

test('complete export metadata retains runtime and current credentials without a local site identity', () => {
  const admin = { name: 'Current owner', username: 'site-owner', email: 'owner@example.test', password: 'Same-sandbox-password-123!' };
  const configuration = { deployId: 'blank', sourceDeployId: 'blank', phpVersion: '8.4', joomlaVersion: '6.2.0',
    siteName: 'Edited sandbox', initialPath: '/administrator/', storageKey: 'original-site', fresh: true,
    persistence: true, admin: { ...admin, username: 'previous-owner' },
    extensions: [{ url: 'https://example.test/extension.zip', sha256: 'a'.repeat(64) }], addonExtensions: [],
    startupCommands: [['cache:clean']], addonStartupCommands: [['cache:clean']],
    snapshot: { url: 'https://example.test/prebuilt.zip', sha256: 'b'.repeat(64) } };
  const metadata = exportPlaygroundConfiguration({ configuration, installation: { administrator: admin } });
  assert.equal(metadata.schemaVersion, 1);
  assert.deepEqual(metadata.configuration.admin, admin);
  assert.equal(metadata.configuration.phpVersion, '8.4');
  assert.equal(metadata.configuration.joomlaVersion, '6.2.0');
  assert.deepEqual(metadata.configuration.extensions, configuration.extensions);
  assert.deepEqual(metadata.configuration.startupCommands, configuration.startupCommands);
  assert.equal(metadata.configuration.fresh, false);
  assert.equal('storageKey' in metadata.configuration, false);
  assert.equal('snapshot' in metadata.configuration, false);
  assert.equal(configuration.fresh, true, 'Export must not change the running configuration.');
  assert.throws(() => exportPlaygroundConfiguration({}), /configuration is unavailable/);
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
    class JConfig { public $host='localhost'; public $user='root'; public $password=''; public $db='joomla'; public $sitename='Actual site title'; public $log_path='/persist/www/administrator/logs'; public $tmp_path='/persist/www/tmp'; public $session_handler='filesystem'; public $session_filesystem_path='/persist/sessions'; }
    $configuration = exportConfiguration(new JConfig(), ['name'=>'destination','user'=>'site_owner','password'=>"a'b\\\\c"]);
    token_get_all($configuration, TOKEN_PARSE);
    if (!is_dir('/persist/meta')) mkdir('/persist/meta', 0700, true);
    $admin = ['name'=>'Same owner','username'=>'same-user','email'=>'same@example.test','password'=>'Same-sandbox-password-123!'];
    file_put_contents('/persist/meta/administrator.json', json_encode(['schemaVersion'=>1,'administrator'=>$admin]));
    $playground = exportPlaygroundConfiguration(['schemaVersion'=>1,'configuration'=>['siteName'=>'Old name','joomlaVersion'=>'5.0.0','phpVersion'=>'8.3','storageKey'=>'old-site','snapshot'=>['url'=>'old.zip']]], '/persist/www', new JConfig(), '6.2.0');
    $records = [
      ['name'=>'site/配置😀.php','size'=>5,'sha256'=>hash('sha256','hello')],
      ['name'=>'database.ndjson','size'=>2,'sha256'=>hash('sha256','[]')],
      ['name'=>'database.sql','size'=>0,'sha256'=>hash('sha256','')],
    ];
    $contentHash = exportPayloadHash($records);
    $reorderedHash = exportPayloadHash(array_reverse($records));
    $records[0]['sha256'] = hash('sha256','world');
    $changedHash = exportPayloadHash($records);
    echo json_encode(['view'=>$portable,'trigger'=>$trigger,'compoundRejected'=>$rejected,'crossDatabaseRejected'=>$crossDatabaseRejected,'cteRejected'=>$cteRejected,'configuration'=>$configuration,'playground'=>$playground,'contentHash'=>$contentHash,'reorderedHash'=>$reorderedHash,'changedHash'=>$changedHash], JSON_THROW_ON_ERROR);
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
  assert.deepEqual(value.playground.configuration.admin, { name: 'Same owner', username: 'same-user', email: 'same@example.test', password: 'Same-sandbox-password-123!' });
  assert.equal(value.playground.configuration.siteName, 'Actual site title');
  assert.equal(value.playground.configuration.joomlaVersion, '6.2.0');
  assert.equal(value.playground.configuration.phpVersion, '8.4');
  assert.equal(value.playground.configuration.fresh, false);
  assert.equal('storageKey' in value.playground.configuration, false);
  assert.equal('snapshot' in value.playground.configuration, false);
  const payload = [['site/配置😀.php', 'hello'], ['database.ndjson', '[]'], ['database.sql', '']]
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([name, bytes]) => `${Buffer.byteLength(name)}:${name}:${Buffer.byteLength(bytes)}:${createHash('sha256').update(bytes).digest('hex')}\n`).join('');
  assert.deepEqual(value.contentHash, { algorithm: 'sha256', format: 'joomengine-site-payload-v1', value: createHash('sha256').update(payload).digest('hex') });
  assert.deepEqual(value.reorderedHash, value.contentHash, 'Payload order is canonical and independent of ZIP enumeration.');
  assert.notEqual(value.changedHash.value, value.contentHash.value, 'Changed site file content changes the single payload hash.');
  await php.refresh();
});

test('PHP importer validates streamed site payload before destination writes and accepts legacy bundles', { timeout: 120_000 }, async () => {
  const members = [
    ['site/configuration.php', '<?php class JConfig {}'], ['site/index.php', '<?php echo "site";'],
    ['site/libraries/vendor/autoload.php', '<?php'], ['site/administrator/manifests/files/joomla.xml', '<extension><version>6.2.0</version></extension>'],
    ['site/配置😀.txt', 'Edited site content '.repeat(12_000)], ['database.sql', 'SELECT 1;\n'], ['database.ndjson', '"SELECT 1"\n'],
  ];
  const canonical = [...members].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([name, bytes]) => `${Buffer.byteLength(name)}:${name}:${Buffer.byteLength(bytes)}:${createHash('sha256').update(bytes).digest('hex')}\n`).join('');
  const contentHash = { algorithm: 'sha256', format: 'joomengine-site-payload-v1', value: createHash('sha256').update(canonical).digest('hex') };
  const metadata = { schemaVersion: 1, format: 'joomengine-playground-export', joomlaVersion: '6.2.0', playground: { configuration: { siteName: 'Metadata may change' }, contentHash } };
  const fixture = Buffer.from(JSON.stringify({ metadata, members: [...members, ['site/cache/', ''], ['DEPLOYMENT.md', 'Instructions may change'], ['export.json', JSON.stringify(metadata)]] })).toString('base64');
  const php = new PhpNode({ version: '8.4', persist: [] });
  let output = '', errors = '';
  php.addEventListener('output', event => { output += event.detail.join(''); });
  php.addEventListener('error', event => { errors += event.detail.join(''); });
  await php.writeFile('/import.php', await readFile(new URL('../src/joomla/php/import.php', import.meta.url), 'utf8'));
  const result = await php.run(`<?php
    // Use real PHP streams while isolating hashing from the ZIP shared library.
    class ZipArchive {
      public int $numFiles;
      public function __construct(public array $members) { $this->numFiles = count($members); }
      public function statIndex(int $index): array { return ['name'=>$this->members[$index][0], 'size'=>strlen($this->members[$index][1])]; }
      public function locateName(string $name): int|false { foreach ($this->members as $index=>$member) if ($member[0] === $name) return $index; return false; }
      public function getFromName(string $name): string|false { $index=$this->locateName($name); return $index === false ? false : $this->members[$index][1]; }
      public function getStream(string $name) { $stream=fopen('php://temp','w+b'); fwrite($stream,$this->getFromName($name)); rewind($stream); return $stream; }
    }
    function playgroundRoot(array $options): string { return '/imported'; }
    function playgroundValidateArchive(string $path, int $limit): ZipArchive { return $GLOBALS['package']; }
    function playgroundFinish(array $result): void { $GLOBALS['importResult']=$result; }
    $fixture=json_decode(base64_decode('${fixture}'),true,512,JSON_THROW_ON_ERROR);
    $metadata=$fixture['metadata'];
    $package=new ZipArchive($fixture['members']);
    $package->members[1][1]='changed before validation';
    $playground=['archive'=>'/example.zip','joomlaVersion'=>'6.2.0'];
    require '/import.php';
    $initialResult=$importResult;
    $package=new ZipArchive($fixture['members']);
    $valid=playgroundValidateContentHash($package,$metadata);
    $legacy=playgroundValidateContentHash($package,['schemaVersion'=>1]);
    $metadata['playground']['configuration']['siteName']='Changed metadata';
    $package->members[count($package->members)-1][1]='changed export metadata';
    $package->members[count($package->members)-2][1]='changed instructions';
    $metadataExcluded=playgroundValidateContentHash($package,$metadata);
    $reordered=playgroundValidateContentHash(new ZipArchive(array_reverse($fixture['members'])),$metadata);
    $failures=[];
    foreach (['file','database','added','duplicate','malformed'] as $case) {
      $changed=new ZipArchive($fixture['members']); $expected=$metadata;
      if ($case === 'file') $changed->members[4][1].='changed';
      elseif ($case === 'database') $changed->members[6][1].='"SELECT 2"';
      elseif ($case === 'added') { $changed->members[]=['site/added.txt','new']; ++$changed->numFiles; }
      elseif ($case === 'duplicate') { $changed->members[]=$changed->members[0]; ++$changed->numFiles; }
      else $expected['playground']['contentHash']=null;
      try { playgroundValidateContentHash($changed,$expected); $failures[$case]=false; }
      catch (RuntimeException $error) { $failures[$case]=str_starts_with($error->getMessage(),'Package validation failed:'); }
    }
    echo json_encode(['valid'=>$valid,'legacy'=>$legacy,'metadataExcluded'=>$metadataExcluded,'reordered'=>$reordered,'failures'=>$failures,'initialResult'=>$initialResult,'destinationExists'=>file_exists('/imported')],JSON_THROW_ON_ERROR);
  `);
  assert.equal(result, 0, `${errors}\n${output}`);
  assert.equal(errors, '');
  const value = JSON.parse(output);
  assert.equal(value.valid, true);
  assert.equal(value.legacy, false);
  assert.equal(value.metadataExcluded, true);
  assert.equal(value.reordered, true);
  assert.deepEqual(value.failures, { file: true, database: true, added: true, duplicate: true, malformed: true });
  assert.equal(value.initialResult.ok, false);
  assert.match(value.initialResult.error, /^Package validation failed:.*content hash/);
  assert.equal(value.destinationExists, false, 'Validation rejects corruption before creating destination files.');
  await php.refresh();
});
