import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { catalogForRestoredSite, configurationForSiteExport, readSiteExport, SITE_EXPORT_FORMAT_ERROR } from '../src/site-import.mjs';

const admin = { name: 'Site owner', username: 'same-owner', email: 'owner@example.test', password: 'Same-sandbox-password-123!' };
const catalog = {
  php: [{ version: '8.3' }, { version: '8.4' }, { version: '8.5' }],
  joomla: [{ version: '5.4.10', php: ['8.3', '8.4'] }, { version: '6.2.0', php: ['8.4', '8.5'] },
    { version: '7.0.0-alpha2-dev', php: ['8.4', '8.5'] }],
  defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' },
};
const contentHash = { algorithm: 'sha256', format: 'joomengine-site-payload-v1', value: 'a'.repeat(64) };

function bundle({ version = '6.2.0', minimum = '8.3.0', configuration, legacy = false, metadata: override, files: extras = {}, omit = [] } = {}) {
  const metadata = { schemaVersion: 1, format: 'joomengine-playground-export', joomlaVersion: version,
    phpVersion: '8.4.1', siteName: 'Saved edited site', archiveLayout: { files: 'site/', database: 'database.sql' },
    ...(!legacy && { playground: { schemaVersion: 1, configuration: configuration ?? {
      siteName: 'Original site name', admin, initialPath: '/administrator/index.php?option=com_content', phpVersion: '8.4',
    }, contentHash } }), ...override };
  const files = {
    'export.json': JSON.stringify(metadata), 'database.sql': 'SELECT 1;\n', 'database.ndjson': '"SELECT 1"\n',
    'site/configuration.php': '<?php class JConfig {}', 'site/index.php': '<?php echo "edited site";',
    'site/libraries/vendor/autoload.php': '<?php',
    'site/administrator/manifests/files/joomla.xml': `<extension><version>${version}</version><php_minimum>${minimum}</php_minimum></extension>`,
    ...extras,
  };
  for (const name of omit) delete files[name];
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, strToU8(bytes)])));
}

const read = bytes => readSiteExport(bytes, { unzip: unzipSync });
const invalid = { message: SITE_EXPORT_FORMAT_ERROR };

test('complete export reader accepts current metadata and reads only the two small metadata files', async () => {
  const bytes = bundle({ files: { 'site/edited.txt': 'Edited content', 'site/cache/': '' } });
  const extracted = [];
  const result = await readSiteExport(new Blob([bytes]), { unzip(input, options) {
    return unzipSync(input, { filter(entry) { const selected = options.filter(entry); if (selected) extracted.push(entry.name); return selected; } });
  } });
  assert.deepEqual(extracted.sort(), ['export.json', 'site/administrator/manifests/files/joomla.xml']);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.phpMinimum, '8.3.0');
  assert.equal(result.preserveAdministrator, true);
  assert.deepEqual(result.metadata.playground.contentHash, contentHash);
  assert.deepEqual(result.metadata.playground.configuration.admin, admin);
});

test('legacy complete exports remain readable without a content hash or browser credentials', async () => {
  const result = await read(bundle({ legacy: true }));
  assert.equal(result.metadata.playground, undefined);
  assert.equal(result.preserveAdministrator, false);
  const config = configurationForSiteExport(result, catalog, { admin, storageKey: 'import-legacy' });
  assert.deepEqual(config.admin, admin);
  assert.equal(config.initialPath, '/administrator/');
  assert.equal(config.storageKey, 'import-legacy');
});

test('ordinary extension ZIPs, malformed data, and partial exports get the complete-site message', async () => {
  const extension = zipSync({ 'extension.xml': strToU8('<extension type="component"/>'), 'site/index.php': strToU8('<?php') });
  await assert.rejects(read(extension), invalid);
  await assert.rejects(read(new Uint8Array()), invalid);
  await assert.rejects(read(strToU8('not a ZIP')), invalid);
  for (const missing of ['export.json', 'database.sql', 'database.ndjson', 'site/configuration.php', 'site/index.php',
    'site/libraries/vendor/autoload.php', 'site/administrator/manifests/files/joomla.xml']) {
    await assert.rejects(read(bundle({ omit: [missing] })), invalid, missing);
  }
  await assert.rejects(read(bundle({ files: { 'site/installation/joomla.php': '<?php' } })), invalid);
});

test('reader rejects unsafe paths and invalid export metadata before runtime startup', async () => {
  for (const name of ['/absolute.php', 'site/../outside.php', 'site/./ambiguous.php', 'site//ambiguous.php', 'site\\outside.php', 'site/zero\0.php']) {
    await assert.rejects(read(bundle({ files: { [name]: 'invalid' } })), invalid, name);
  }
  for (const metadata of [{ schemaVersion: 2 }, { format: 'extension' }, { archiveLayout: { files: '/', database: 'database.sql' } },
    { joomlaVersion: '5.4.10' }, { playground: { schemaVersion: 2, configuration: {} } }, { playground: { schemaVersion: 1, configuration: [] } }]) {
    await assert.rejects(read(bundle({ metadata })), invalid);
  }
  await assert.rejects(read(bundle({ files: { 'export.json': 'invalid JSON' } })), invalid);
  await assert.rejects(read(bundle({ files: { 'export.json': ' '.repeat(1024 * 1024 + 1) } })), invalid);
  await assert.rejects(readSiteExport({ size: 512 * 1024 * 1024 + 1 }), { message: 'The site export ZIP exceeds 512 MiB.' });
});

test('restored configuration preserves the login and opening page with a fresh independent identity', async () => {
  const initialPath = '/administrator/index.php?option=com_componentbuilder#dashboard';
  const original = { admin, initialPath, siteName: 'Original title', phpVersion: '8.5', storageKey: 'original-site',
    deployId: 'custom-no-longer-saved', sourceDeployId: 'jcb', jcbVersion: '6.2.0',
    joomlaPackage: { url: 'https://missing.test/joomla.zip', sha256: 'b'.repeat(64), php: ['8.4', '8.5'] },
    jcbPackage: { url: 'https://missing.test/jcb.zip', sha256: 'c'.repeat(64) },
    snapshot: { url: 'https://missing.test/snapshot.zip' }, deploymentRecipe: { schemaVersion: 2, name: 'Deleted recipe' },
    extensions: [{ url: 'https://missing.test/already-installed.zip' }], startupCommands: [['cache:clean']], fresh: true };
  const input = await read(bundle({ configuration: original }));
  const first = configurationForSiteExport(input, catalog);
  const second = configurationForSiteExport(input, catalog);
  assert.deepEqual(first.admin, admin);
  assert.equal(first.initialPath, initialPath);
  assert.equal(first.siteName, 'Saved edited site');
  assert.equal(first.phpVersion, '8.5');
  assert.equal(first.deployId, 'blank');
  assert.equal(first.persistence, true);
  assert.equal(first.fresh, false);
  assert.match(first.storageKey, /^import-/);
  assert.notEqual(first.storageKey, original.storageKey);
  assert.notEqual(first.storageKey, second.storageKey);
  for (const name of ['joomlaPackage', 'jcbPackage', 'snapshot', 'deploymentRecipe']) assert.equal(name in first, false, name);
  assert.deepEqual(first.restoredSite, { joomlaVersion: '6.2.0', php: ['8.4', '8.5'] });
  assert.equal(input.metadata.playground.configuration.storageKey, 'original-site', 'Import never modifies the export metadata.');
});

test('old releases and nightlies restore from site files while using an available PHP runtime', async () => {
  for (const version of ['5.4.2', '7.0.0-alpha1-dev']) {
    const input = await read(bundle({ version, legacy: true }));
    const config = configurationForSiteExport(input, catalog, { admin });
    assert.equal(config.joomlaVersion, version);
    const restored = catalogForRestoredSite(catalog, config);
    assert.equal(restored.joomla.find(entry => entry.version === version).channel, 'saved');
    assert.equal(catalog.joomla.some(entry => entry.version === version), false);
    assert.ok(restored.joomla.find(entry => entry.version === version).php.includes(config.phpVersion));
  }
  const knownPackage = await read(bundle({ version: '8.0.0-alpha1-dev', configuration: { admin,
    joomlaPackage: { url: 'https://missing.test/old.zip', sha256: 'b'.repeat(64), php: ['8.4', '8.5'] } } }));
  assert.equal(configurationForSiteExport(knownPackage, catalog).joomlaVersion, '8.0.0-alpha1-dev');
});

test('unavailable PHP compatibility fails clearly and cannot add arbitrary runtimes', async () => {
  const error = { message: 'This exported site needs a PHP runtime that is unavailable here.' };
  const tooNew = await read(bundle({ minimum: '8.6.0' }));
  assert.throws(() => configurationForSiteExport(tooNew, catalog), error);
  const unknownMajor = await read(bundle({ version: '8.0.0-alpha1-dev', legacy: true }));
  assert.throws(() => configurationForSiteExport(unknownMajor, catalog, { admin }), error);
  for (const restoredSite of [{ joomlaVersion: '6.2.0', php: ['8.6'] }, { joomlaVersion: '6.2.0', php: [] }, { joomlaVersion: '5.4.2', php: ['8.4'] }]) {
    assert.throws(() => catalogForRestoredSite(catalog, { joomlaVersion: '6.2.0', restoredSite }), error);
  }
  assert.equal(catalogForRestoredSite(catalog, {}), catalog);
});
