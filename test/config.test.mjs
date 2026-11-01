import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogWithSelectedJoomlaPackage, createShareURL, normalizeConfiguration, normalizeInitialPath, resolveSiteURL, parseCatalog, parseExtensions, parseUserExtensions, parseUserTemplate, parseStartupCommands, readURLConfiguration, createFullDeploymentDocument, createDeploymentDocument, normalizeDeploymentRecipe, normalizeDeploymentRequirements, parseDeploymentDocument } from '../src/config.mjs';

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

test('saved nightly compatibility follows its exact archive after the published dev build changes', () => {
  const version = '7.0.0-alpha1-dev';
  const currentHash = 'a'.repeat(64);
  const stable = manifest.joomla.map(entry => entry.version === '6.2.0'
    ? { ...entry, url: 'https://example.test/stable.zip', sha256: currentHash } : entry);
  const catalog = parseCatalog({ ...manifest, joomla: [...stable,
    { version, url: 'https://example.test/current.zip', sha256: currentHash, php: ['8.4'], phpMinimum: '8.4.0' }] });
  const saved = { admin, joomlaVersion: version, phpVersion: '8.4', storageKey: 'saved-nightly',
    joomlaPackage: { url: 'https://example.test/older.zip', sha256: 'b'.repeat(64), php: ['8.3', '8.4'] } };
  const restoredCatalog = catalogWithSelectedJoomlaPackage(catalog, saved);
  const restored = normalizeConfiguration(saved, { catalog: restoredCatalog });
  assert.deepEqual(restored.joomlaPackage, saved.joomlaPackage);
  assert.equal(restored.phpVersion, '8.4');
  assert.equal(restored.storageKey, 'saved-nightly');
  assert.deepEqual(catalog.joomla.find(entry => entry.version === version).php, ['8.4'], 'The published catalog stays unchanged.');

  assert.throws(() => catalogWithSelectedJoomlaPackage(catalog,
    { ...saved, joomlaPackage: { ...saved.joomlaPackage, sha256: currentHash } }), /PHP 8\.3 is not available/,
  'The same archive cannot broaden published compatibility, even through another URL.');
  assert.throws(() => catalogWithSelectedJoomlaPackage(catalog,
    { ...saved, joomlaPackage: { ...saved.joomlaPackage, php: ['8.4', '8.2'] } }), /PHP 8\.2 is not available/,
  'A saved archive cannot add a runtime that this host does not ship.');
  assert.throws(() => catalogWithSelectedJoomlaPackage(catalog,
    { ...saved, joomlaVersion: '6.2.0' }), /PHP 8\.3 is not available/,
  'A changed hash does not relax immutable stable-release compatibility.');
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
  assert.equal(parseExtensions([{ url: 'http://example.com/a.zip' }])[0].url, 'http://example.com/a.zip');
  for (const url of ['javascript:alert(1)', 'data:application/zip,test', 'https://user:password@example.com/a.zip', 'https://example.com/a.zip#fragment']) {
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

test('HTTP extension URLs round-trip without changing language or configuration-source policies', async () => {
  const { createDeploymentDocument, parseDeploymentDocument, createDeploymentSourceURL, loadDeploymentDocument } = await import('../src/config.mjs');
  const extensions = [{ url: 'http://example.test/package.zip' }];
  assert.deepEqual(normalizeConfiguration({ admin, extensions }).extensions, extensions);
  assert.deepEqual(readURLConfiguration(createShareURL('https://playground.test/', { extensions })).config.extensions, extensions);
  assert.deepEqual(parseDeploymentDocument(createDeploymentDocument({ extensions })).extensions, extensions);
  const languages = [{ tag: 'af-ZA', url: 'http://example.test/af.zip', sha256: 'a'.repeat(64) }];
  assert.throws(() => normalizeConfiguration({ admin, languages }), /HTTPS/);
  assert.throws(() => parseDeploymentDocument({ schemaVersion: 1, configuration: { languages } }), /HTTPS/);
  assert.throws(() => readURLConfiguration('https://playground.test/?config=http%3A%2F%2Fexample.test%2Fdeploy.json'), /HTTPS/);
  assert.throws(() => createDeploymentSourceURL('https://playground.test/', { url: 'http://example.test/deploy.json' }), /HTTPS/);
  await assert.rejects(loadDeploymentDocument('http://example.test/deploy.json'), /HTTPS/);
  assert.throws(() => parseExtensions('["https://example.test/package.zip"]'), /object containing a url/);
});

test('complete deployment exports preserve private setup, materialized packages and provenance', () => {
  const managed = { url: 'https://example.test/managed.zip', sha256: 'a'.repeat(64) };
  const custom = { url: 'https://example.test/custom.zip', sha256: 'not-a-digest', sha512: 42 };
  const configuration = {
    deployId: 'jcb', sourceDeployId: 'jcb', joomlaVersion: '6.2.0', jcbVersion: '6.2.0', phpVersion: '8.4', siteName: 'My complete site',
    initialPath: '/administrator/', admin: { name: 'Site owner', username: 'owner', email: 'owner@example.test', password: 'a-private-long-password' },
    extensions: [managed, custom], addonExtensions: [custom], startupCommands: [['cache:clean'], ['config:set', 'sitename', 'My site']],
    addonStartupCommands: [['config:set', 'sitename', 'My site']], languageTags: ['af-ZA'],
    languages: [{ tag: 'af-ZA', url: 'https://example.test/af.zip', sha256: 'b'.repeat(64) }], addonLanguages: [],
    template: { url: 'https://example.test/managed-template.zip', element: 'reviewed', sha256: 'c'.repeat(64) }, addonTemplate: null,
    menus: [], phpSettings: { memory_limit: '512M' },
    content: { categories: [], articles: [] }, storageKey: 'browser-only', snapshot: { url: 'https://example.test/prebuilt.zip' },
  };
  const requirements = { joomla: ['5', '6'], jcb: 'required', php: ['8.4', '8.5'], joomlaFallbacks: { '7': '6' } };
  const document = createFullDeploymentDocument(configuration, { name: 'Component Builder Custom', requirements });
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.name, 'Component Builder Custom');
  assert.deepEqual(document.requirements, requirements);
  assert.deepEqual(document.configuration.admin, configuration.admin);
  assert.equal(document.configuration.sourceDeployId, 'jcb');
  assert.deepEqual(document.configuration.template, { ...configuration.template, params: {}, menuKeys: [] });
  assert.deepEqual(document.configuration.extensions, [managed, { url: custom.url }]);
  assert.deepEqual(document.configuration.addonExtensions, [{ url: custom.url }]);
  assert.deepEqual(document.configuration.startupCommands, configuration.startupCommands);
  assert.deepEqual(document.configuration.addonStartupCommands, configuration.addonStartupCommands);
  assert.equal(document.configuration.storageKey, undefined);
  assert.equal(document.configuration.snapshot, undefined);
  const parsed = parseDeploymentDocument(JSON.stringify(document));
  assert.deepEqual(parsed.deploymentRecipe, document);
  assert.deepEqual(createFullDeploymentDocument(parsed), document, 'Saving an imported recipe is idempotent and does not nest recipes.');
  assert.deepEqual(createDeploymentDocument(configuration, { includePrivate: true, name: document.name, requirements }), document);
});

test('custom share links carry their standalone recipe without administrator or browser state', () => {
  const full = createFullDeploymentDocument({ deployId: 'custom-local-only', siteName: 'Shared custom',
    admin: { name: 'Private owner', email: 'private@example.test', password: 'private-long-password' },
    extensions: [{ url: 'https://example.test/extension.zip' }], startupCommands: [['cache:clean']],
    template: { element: 'cassiopeia' }, storageKey: 'local-only-key',
  }, { name: 'My custom deployment', requirements: { joomla: ['6'], jcb: 'optional' } });
  const parsed = parseDeploymentDocument(full);
  const shared = createDeploymentDocument(parsed);
  assert.equal(shared.schemaVersion, 1);
  assert.equal(shared.configuration.deploymentRecipe.name, full.name);
  assert.equal(shared.configuration.deploymentRecipe.configuration.admin, undefined);
  assert.doesNotMatch(JSON.stringify(shared), /Private owner|private@example|private-long-password|local-only-key/);
  const restored = readURLConfiguration(createShareURL('https://playground.test/', parsed)).config;
  assert.deepEqual(restored, parseDeploymentDocument(shared));
  assert.deepEqual(restored.deploymentRecipe.configuration.extensions, full.configuration.extensions);
  assert.throws(() => parseDeploymentDocument(full, { publicOnly: true }), /unsupported property admin/);
  const secretCommand = parseDeploymentDocument(createFullDeploymentDocument({ startupCommands: [['user:add', '--password=private-value']] }, { name: 'Private setup' }));
  assert.throws(() => createShareURL('https://playground.test/', secretCommand), /secrets/);
});

test('user package and template checksum metadata never blocks the normal installer URL', () => {
  const entry = { url: 'https://example.test/custom.zip', sha256: 'bad', sha512: { invalid: true } };
  assert.deepEqual(parseUserExtensions(JSON.stringify([entry])), [{ url: entry.url }]);
  assert.throws(() => parseExtensions([entry]), /SHA-256/);
  const template = parseUserTemplate(JSON.stringify({ ...entry, element: 'custom' }));
  assert.equal(template.url, entry.url);
  assert.equal(template.sha256, undefined);
  const document = createFullDeploymentDocument({ extensions: [entry], template: { ...entry, element: 'custom' }, addonTemplate: { ...entry, element: 'custom' } }, { name: 'Custom URLs' });
  assert.deepEqual(document.configuration.extensions, [{ url: entry.url }]);
  assert.equal(document.configuration.template.sha256, undefined);
  const claimedManaged = normalizeDeploymentRecipe({ ...document, configuration: { extensions: [entry], addonExtensions: [], template: { ...entry, element: 'custom' }, addonTemplate: null } });
  assert.deepEqual(claimedManaged.configuration.extensions, [{ url: entry.url }]);
  assert.equal(claimedManaged.configuration.template.sha256, undefined, 'Unverified imported provenance cannot make a malformed user checksum block the installer.');
  assert.equal(parseDeploymentDocument({ schemaVersion: 1, configuration: { extensions: [entry] } }).extensions[0].sha256, undefined);
  for (const url of ['javascript:alert(1)', 'https://user:password@example.test/a.zip']) assert.throws(() => parseUserExtensions([{ ...entry, url }]));
});

test('direct runtime custom URLs ignore checksums before validation while explicit managed packages stay strict', () => {
  const custom = { url: './custom.zip', sha256: 'ignored', sha512: { invalid: true } };
  const template = { url: './template.zip', element: 'custom', sha256: 'ignored' };
  const baseURL = 'https://example.test/';
  for (const input of [
    { extensions: [custom], template },
    { extensions: [custom], addonExtensions: [custom], template, addonTemplate: template },
  ]) {
    const normalized = normalizeConfiguration({ ...input, admin }, { baseURL });
    assert.deepEqual(normalized.extensions, [{ url: 'https://example.test/custom.zip' }]);
    assert.deepEqual(normalized.addonExtensions, normalized.extensions);
    assert.equal(normalized.template.sha256, undefined);
    assert.equal(normalized.addonTemplate.url, 'https://example.test/template.zip');
  }
  const managed = { url: 'https://example.test/managed.zip', sha256: 'a'.repeat(64) };
  const mixed = normalizeConfiguration({ admin, extensions: [managed, custom], addonExtensions: [custom] }, { baseURL });
  assert.deepEqual(mixed.extensions, [managed, { url: 'https://example.test/custom.zip' }]);
  assert.throws(() => normalizeConfiguration({ admin, extensions: [custom], addonExtensions: [] }, { baseURL }), /SHA-256/);
  assert.throws(() => normalizeConfiguration({ admin, template, addonTemplate: null }, { baseURL }), /SHA-256/);
  assert.throws(() => normalizeConfiguration({ admin, template, addonTemplate: { ...template, url: './different.zip' } }, { baseURL }), /SHA-256/);
  assert.equal(custom.sha256, 'ignored', 'Normalization does not mutate caller input.');
});

test('portable recipe validation rejects malformed requirements, nesting, unsafe keys and oversize data', () => {
  const document = createFullDeploymentDocument({ siteName: 'Validated' }, { name: 'Validated' });
  assert.deepEqual(normalizeDeploymentRequirements({ joomla: ['7', '7'], jcb: 'optional' }).joomla, ['7']);
  for (const requirements of [{ joomla: [] }, { joomla: ['4'] }, { joomla: ['6'], jcb: 'sometimes' }, { joomla: ['6'], php: ['8'] }, { joomla: ['6'], joomlaFallbacks: { '7': '5' } }]) {
    assert.throws(() => normalizeDeploymentRecipe({ ...document, requirements }));
  }
  assert.throws(() => normalizeDeploymentRecipe({ ...document, configuration: { deploymentRecipe: document } }), /unsupported property deploymentRecipe/);
  assert.throws(() => normalizeDeploymentRecipe({ ...document, configuration: { admin: { password: 'short' } } }), /at least 12/);
  assert.throws(() => parseDeploymentDocument('{"schemaVersion":2,"name":"Unsafe","requirements":{"joomla":["6"]},"configuration":{"content":{"__proto__":{}}}}'), /invalid property/);
  assert.throws(() => createFullDeploymentDocument({ content: { articles: ['x'.repeat(1_048_576)] } }), /exceeds/);
});
