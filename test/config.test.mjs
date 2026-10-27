import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareURL, normalizeConfiguration, normalizeInitialPath, parseCatalog, parseExtensions, parseStartupCommands, readURLConfiguration } from '../src/config.mjs';

const manifest = {
  php: [{ version: '8.3' }, { version: '8.4' }, { version: '8.5' }],
  joomla: [{ version: '5.4.10', php: ['8.3', '8.4'] }, { version: '6.2.0', php: ['8.4', '8.5'] }],
  defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' },
};
const admin = { password: 'a-long-test-password' };

test('catalog limits configuration to a tested version combination', () => {
  const catalog = parseCatalog(manifest);
  assert.equal(normalizeConfiguration({ admin }, { catalog }).joomlaVersion, '6.2.0');
  assert.equal(normalizeConfiguration({ admin, joomlaVersion: '5.4' }, { catalog }).joomlaVersion, '5.4.10');
  assert.throws(() => normalizeConfiguration({ admin, phpVersion: '8.3' }, { catalog }), /not available/);
  assert.throws(() => parseCatalog({ ...manifest, defaults: { phpVersion: '8.2', joomlaVersion: '6.2.0' } }), /incompatible/);
  assert.throws(() => parseCatalog({ php: [], joomla: [] }), /No tested/);
});

test('initial pages remain within the playground route', () => {
  assert.equal(normalizeInitialPath('/administrator/index.php?option=com_content#articles'), '/administrator/index.php?option=com_content#articles');
  for (const path of ['https://example.com', '//example.com', '/%2fexample.com', '/%2e%2e/private', '/a/../private', '/a\\b', '/%0aheader', '/%zz']) {
    assert.throws(() => normalizeInitialPath(path), undefined, path);
  }
});

test('extension packages normalize URLs and validate checksums', () => {
  const digest = 'AB'.repeat(32);
  assert.deepEqual(parseExtensions(JSON.stringify([{ url: './extension.zip', sha256: digest }]), 'https://example.test/play/'), [{ url: 'https://example.test/play/extension.zip', sha256: digest.toLowerCase() }]);
  assert.equal(parseExtensions([{ url: 'http://localhost:8080/extension.zip' }])[0].url, 'http://localhost:8080/extension.zip');
  for (const url of ['javascript:alert(1)', 'data:application/zip,test', 'http://example.com/a.zip', 'https://user:password@example.com/a.zip', 'https://example.com/a.zip#fragment']) {
    assert.throws(() => parseExtensions([{ url }]), undefined, url);
  }
  assert.throws(() => parseExtensions([{ url: 'https://example.com/a.zip', sha256: 'abc' }]), /64 hexadecimal/);
});

test('startup commands preserve argument boundaries without a shell', () => {
  assert.deepEqual(parseStartupCommands('[["cache:clean"],["config:set","sitename","A site; echo example"]]'), [['cache:clean'], ['config:set', 'sitename', 'A site; echo example']]);
  for (const commands of ['["cache:clean"]', '[[]]', '[[""]]', '[1]', 'not json', '[["one", 2]]', '[["one\\nsecond"]]']) assert.throws(() => parseStartupCommands(commands));
});

test('configuration validates credentials, storage and booleans', () => {
  assert.throws(() => normalizeConfiguration({ admin: { password: 'short' } }), /at least 12/);
  assert.throws(() => normalizeConfiguration({ admin, persistence: 'false' }), /must be true or false/);
  assert.throws(() => normalizeConfiguration({ admin, storageKey: '../other' }), /Site key/);
  assert.throws(() => normalizeConfiguration({ admin, storageKey: 123 }), /Site key/);
  assert.throws(() => normalizeConfiguration({ admin: { ...admin, email: 'bad' } }), /email address/);
  const config = normalizeConfiguration({ admin, persistence: false, extensions: [], startupCommands: [] });
  assert.equal(config.persistence, false);
  assert.equal(config.admin.username, 'admin');
});

test('URL deployment options validate packages and commands while excluding credentials', () => {
  const url = new URL('https://example.test/?blueprint=blank&php=8.5&joomla=6.2&language=nl-NL&login=no&fresh=1&path=%2Fadministrator%2F&toolbar=0&persist=0&password=secret');
  url.searchParams.set('extensions', JSON.stringify([{ url: './public-package.zip' }]));
  url.searchParams.set('commands', JSON.stringify([['cache:clean']]));
  const { config, autostart } = readURLConfiguration(url);
  assert.deepEqual(config, { blueprintId: 'blank', phpVersion: '8.5', joomlaVersion: '6.2', language: 'nl-NL', autoLogin: false, fresh: true,
    initialPath: '/administrator/', hideToolbar: true, persistence: false,
    extensions: [{ url: 'https://example.test/public-package.zip' }], startupCommands: [['cache:clean']] });
  assert.equal(autostart, true);
  assert.equal(readURLConfiguration(`${url}&start=0`).autostart, false);
  assert.equal(readURLConfiguration('https://example.test/?key=my-site').config.storageKey, 'my-site');
  for (const query of ['login=maybe', 'blueprint=../private', 'key=../site', 'commands=not-json', 'language=dutch', 'extension=javascript:alert(1)']) {
    assert.throws(() => readURLConfiguration(`https://example.test/?${query}`));
  }
});

test('share URLs preserve public setup directives without administrator credentials or saved data', () => {
  const url = new URL(createShareURL('https://example.test/play/?secret=old#credentials', {
    phpVersion: '8.4', joomlaVersion: '6.2.0', initialPath: '/administrator/', hideToolbar: true,
    persistence: false, admin: { password: 'secret' }, storageKey: 'private-key',
    blueprintId: 'blank', language: 'nl-NL', autoLogin: false,
    extensions: [{ url: 'https://example.test/public-package.zip' }], startupCommands: [['cache:clean']],
  }));
  assert.equal(url.pathname, '/play/');
  assert.equal(url.searchParams.get('blueprint'), 'blank');
  assert.equal(url.searchParams.get('language'), 'nl-NL');
  assert.equal(url.searchParams.get('login'), 'no');
  assert.deepEqual(JSON.parse(url.searchParams.get('extensions')), [{ url: 'https://example.test/public-package.zip' }]);
  assert.deepEqual(JSON.parse(url.searchParams.get('commands')), [['cache:clean']]);
  assert.equal(url.hash, '');
  assert.equal(url.href.includes('secret'), false);
  assert.equal(url.href.includes('private'), false);
  const { config } = readURLConfiguration(url);
  assert.deepEqual(config.extensions, [{ url: 'https://example.test/public-package.zip' }]);
  assert.deepEqual(config.startupCommands, [['cache:clean']]);
});
