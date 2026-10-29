import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareURL, normalizeConfiguration, normalizeInitialPath, resolveSiteURL, parseCatalog, parseExtensions, parseStartupCommands, readURLConfiguration } from '../src/config.mjs';

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

test('site URL resolution keeps scheme-like paths inert and inside the owned route', () => {
  const base = 'https://playground.example/__site/client/instance/';
  for (const path of ['/javascript:console.log(1)', '/https://example.test/', '/data:text/html,hello', '/javascript%3Aalert(1)']) {
    const result = new URL(resolveSiteURL(path, base));
    assert.equal(result.protocol, 'https:');
    assert.equal(result.origin, 'https://playground.example');
    assert.equal(result.pathname, new URL(base).pathname + path.slice(1));
  }
  assert.equal(resolveSiteURL('/administrator/?option=com_config#settings', base), `${base}administrator/?option=com_config#settings`);
  for (const path of ['//outside.test', '/%2e%2e/private', '/a/../private', '/%5coutside.test']) {
    assert.throws(() => resolveSiteURL(path, base));
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
  assert.equal(config.phpVersion, '8.4');
  assert.equal(config.persistence, false);
  assert.equal(config.admin.username, 'admin');
});

test('URL deployment options validate packages and commands while excluding credentials', () => {
  const url = new URL('https://example.test/?deploy=blank&php=8.5&joomla=6.2&language=nl-NL&login=no&fresh=1&path=%2Fadministrator%2F&toolbar=0&persist=0&password=secret');
  url.searchParams.set('extensions', JSON.stringify([{ url: './public-package.zip' }]));
  url.searchParams.set('commands', JSON.stringify([['cache:clean']]));
  const { config, autostart } = readURLConfiguration(url);
  assert.deepEqual(config, { deployId: 'blank', phpVersion: '8.5', joomlaVersion: '6.2', language: 'nl-NL', autoLogin: false, fresh: true,
    initialPath: '/administrator/', hideToolbar: true, persistence: false,
    extensions: [{ url: 'https://example.test/public-package.zip' }], startupCommands: [['cache:clean']] });
  assert.equal(autostart, true);
  assert.equal(readURLConfiguration(`${url}&start=0`).autostart, false);
  assert.equal(readURLConfiguration('https://example.test/?key=my-site').config.storageKey, 'my-site');
  for (const query of ['login=maybe', 'deploy=../private', 'key=../site', 'commands=not-json', 'language=dutch', 'extension=javascript:alert(1)']) {
    assert.throws(() => readURLConfiguration(`https://example.test/?${query}`));
  }
});

test('share URLs preserve public setup directives without administrator credentials or saved data', () => {
  assert.deepEqual(readURLConfiguration(createShareURL('https://example.test/', { deployId: 'blank' })).config, { deployId: 'blank' });
  const url = new URL(createShareURL('https://example.test/play/?secret=old#credentials', {
    phpVersion: '8.4', joomlaVersion: '6.2.0', initialPath: '/administrator/', hideToolbar: true,
    persistence: false, admin: { password: 'secret' }, storageKey: 'private-key',
    deployId: 'blank', language: 'nl-NL', autoLogin: false,
    extensions: [{ url: 'https://example.test/public-package.zip' }], startupCommands: [['cache:clean']],
  }));
  assert.equal(url.pathname, '/play/');
  assert.equal(url.searchParams.get('deploy'), 'blank');
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

test('a portable deploy round-trips Unicode names, menus, templates and PHP settings without private state', async () => {
  const { createDeploymentDocument, parseDeploymentDocument } = await import('../src/config.mjs');
  const configuration = {
    deployId: 'blank', joomlaVersion: '6.2.0', phpVersion: '8.4', siteName: 'Erfenis — 中文',
    language: 'af-ZA', languageTags: ['af-ZA', 'de-DE', 'zh-CN'], initialPath: '/', autoLogin: false,
    menus: [{ key: 'directory', title: 'Directory', component: 'com_content', view: 'category', query: { id: 2 }, home: true }],
    template: { element: 'cassiopeia', params: { fluidContainer: 1 } }, phpSettings: { upload_max_filesize: '128M', post_max_size: '160M' },
    admin: { password: 'private-secret', email: 'private@example.test' }, storageKey: 'local-private-key',
  };
  const document = createDeploymentDocument(configuration);
  const link = createShareURL('https://playground.joomengine.org/', configuration);
  assert.ok(new URL(link).hash.startsWith('#deploy='));
  const read = readURLConfiguration(link);
  assert.equal(read.autostart, true);
  assert.deepEqual(read.config, parseDeploymentDocument(JSON.stringify(document)));
  assert.equal(read.config.siteName, 'Erfenis — 中文');
  assert.equal(read.config.menus[0].home, true);
  assert.equal(read.config.menus[0].language, '*');
  assert.equal(read.config.phpSettings.upload_max_filesize, '128M');
  assert.doesNotMatch(JSON.stringify(document), /private-secret|private@example|local-private-key/);
  assert.throws(() => parseDeploymentDocument({ schemaVersion: 1, configuration: { admin: { password: 'secret' } } }), /unsupported property admin/);
  assert.throws(() => createDeploymentDocument({ template: { element: 'cassiopeia', params: { api_token: 'private' } } }), /secrets/);
  assert.throws(() => createDeploymentDocument({ startupCommands: [['user:add', '--password=private']] }), /secrets/);
  assert.throws(() => createDeploymentDocument({ initialPath: '/index.php?access_token=private' }), /credentials/);
});

test('large deployment JSON can be fetched with verified integrity and never silently truncated', async () => {
  const { createDeploymentDocument, loadDeploymentDocument, createDeploymentSourceURL } = await import('../src/config.mjs');
  const source = new TextEncoder().encode(JSON.stringify(createDeploymentDocument({ deployId: 'blank', siteName: 'Public demonstration' })));
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', source)).toString('hex');
  const fetcher = async () => new Response(source);
  const link = createDeploymentSourceURL('https://playground.joomengine.org/?old=1', { url: 'https://example.test/deploy.json', sha256 });
  const parsed = readURLConfiguration(link);
  assert.equal(parsed.autostart, true);
  assert.equal(parsed.document.sha256, sha256);
  assert.equal((await loadDeploymentDocument(parsed.document.url, { sha256, fetcher })).siteName, 'Public demonstration');
  await assert.rejects(loadDeploymentDocument(parsed.document.url, { sha256: '0'.repeat(64), fetcher }), /checksum/);
  await assert.rejects(loadDeploymentDocument(parsed.document.url, { fetcher: async () => new Response('x', { headers: { 'Content-Length': '1048577' } }) }), /exceeds/);
  assert.throws(() => createShareURL('https://example.test/', { content: { categories: [], articles: [{ introtext: 'x'.repeat(20_000) }] } }), /too large/);
});

test('menu and template inputs reject ambiguous homes and executable navigation overrides', async () => {
  const { parseMenus, parseTemplate } = await import('../src/config.mjs');
  const menu = { key: 'home', title: 'Home', component: 'com_content', view: 'featured', home: true };
  assert.throws(() => parseMenus([menu, { ...menu, key: 'second' }]), /one home/);
  assert.throws(() => parseMenus([{ ...menu, query: { task: 'item.delete' } }]), /overrides/);
  assert.throws(() => parseMenus([{ ...menu, published: false }]), /must be published/);
  assert.throws(() => parseMenus([{ ...menu, link: 'https://example.test' }]), /unsupported/);
  assert.throws(() => parseTemplate({ element: '../../escape' }), /Template element/);
  assert.throws(() => parseTemplate({ element: 'cassiopeia', url: 'javascript:alert(1)' }), /HTTPS/);
  assert.throws(() => parseMenus(JSON.parse('[{"title":"Bad","component":"com_content","view":"featured","params":{"__proto__":{}}}]')), /invalid/);
});
