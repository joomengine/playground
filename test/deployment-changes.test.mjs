import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentConfigurationChanges } from '../src/deployment-changes.mjs';

const previous = () => ({ siteName: 'Original site', language: 'en-GB', languageTags: ['fr-FR'], multilingual: true,
  extensions: [{ url: 'https://retired.example/installed.zip', sha256: 'a'.repeat(64) }],
  startupCommands: [['custom:setup', '--once']],
  languages: [{ tag: 'fr-FR', url: 'https://retired.example/french.zip' }],
  menus: [{ title: 'Original menu', component: 'com_content', view: 'featured', home: true }],
  template: { url: 'https://retired.example/template.zip', element: 'existing', params: { color: 'blue' } } });

test('renaming a copied site does not replay installed packages, commands or overwrite later Joomla settings', () => {
  const installed = previous();
  const next = { ...structuredClone(installed), siteName: 'Renamed copy' };
  const changes = deploymentConfigurationChanges(installed, next);
  assert.equal(changes.configureLanguage, false, 'Manual defaults and multilingual plugin settings must stay intact.');
  assert.equal(changes.configuration.siteName, 'Renamed copy');
  for (const key of ['extensions', 'startupCommands', 'languages', 'menus']) assert.deepEqual(changes.configuration[key], []);
  assert.equal(changes.configuration.template, null);
  assert.deepEqual(next.extensions, installed.extensions, 'Full metadata is retained for subsequent edits.');
  assert.deepEqual(next.template, installed.template);
});

test('new setup steps and deliberate menu/template edits are applied without reinstalling unchanged template archives', () => {
  const installed = previous();
  const next = structuredClone(installed);
  next.extensions.push({ url: 'https://example.test/new.zip' });
  next.startupCommands.push(['custom:update']);
  next.languages.push({ tag: 'de-DE', url: 'https://example.test/german.zip' });
  next.menus[0].title = 'Edited menu';
  next.template.params.color = 'green';
  const changes = deploymentConfigurationChanges(installed, next);
  assert.deepEqual(changes.configuration.extensions, [next.extensions[1]]);
  assert.deepEqual(changes.configuration.startupCommands, [['custom:update']]);
  assert.deepEqual(changes.configuration.languages, [next.languages[1]]);
  assert.deepEqual(changes.configuration.menus, next.menus);
  assert.deepEqual(changes.configuration.template, { element: 'existing', params: { color: 'green' } });
  assert.equal(changes.configureLanguage, false);
});

test('deliberately changing language defaults enables customization and checks required installed languages', () => {
  const installed = previous();
  for (const change of [{ language: 'fr-FR' }, { languageTags: [] }, { multilingual: false }]) {
    const next = { ...structuredClone(installed), ...change };
    const changes = deploymentConfigurationChanges(installed, next);
    assert.equal(changes.configureLanguage, true);
    assert.deepEqual(changes.configuration.languages, next.languages);
  }
});

test('changed credentials and overlay values apply while unchanged instructions and form metadata do not replay', () => {
  const installed = previous();
  installed.extensions[0].authentication = { type: 'bearer', token: 'old-token' };
  installed.template.authentication = { type: 'bearer', token: 'template-token' };
  installed.overlays = [{ key: 'settings', kind: 'component', component: 'com_example', fields: { params: { title: 'Original' } }, schema: { title: 'Settings' } },
    { key: 'stable', kind: 'plugin', folder: 'system', element: 'example', fields: { enabled: 1 } }];
  const next = structuredClone(installed);
  next.extensions[0].authentication.token = 'new-token';
  next.template.params.color = 'green';
  next.overlays[0].schema.title = 'Localized settings';
  let changes = deploymentConfigurationChanges(installed, next).configuration;
  assert.deepEqual(changes.extensions, next.extensions);
  assert.deepEqual(changes.overlays, []);
  assert.deepEqual(changes.template, { element: 'existing', params: { color: 'green' } });
  next.template.authentication.token = 'replacement-template-token';
  next.overlays[0].fields.params.title = 'Edited';
  changes = deploymentConfigurationChanges(installed, next).configuration;
  assert.deepEqual(changes.template, next.template);
  assert.deepEqual(changes.overlays, [next.overlays[0]]);
});
