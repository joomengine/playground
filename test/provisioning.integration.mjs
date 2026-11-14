import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { normalizeConfiguration, parseCatalog } from '../src/config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { exportSite } from '../src/export.mjs';
import { managedDatabaseSource } from '../src/joomla/managed-database.mjs';
import { deploymentConfigurationChanges } from '../src/deployment-changes.mjs';
import { applyJoomlaConfiguration, captureJoomlaData, discoverJoomlaConfiguration, readJoomlaMetadata, importJoomlaSnapshot, inspectJoomla, installJoomla, requestJoomlaPage, runStartupCommand, sha256 } from '../src/joomla/index.mjs';

const sourceLoader = (name) => readFile(new URL(`../src/joomla/php/${name}.php`, import.meta.url), 'utf8');
const exportSource = () => readFile(new URL('../src/export/site.php', import.meta.url), 'utf8');

async function page(runtime, pathname) {
  const response = await requestJoomlaPage(runtime, pathname);
  assert.equal(response.status, 200, pathname);
  return response.text();
}

async function loginSite(runtime, administrator) {
  const html = await page(runtime, 'index.php?option=com_users&view=login');
  const token = html.match(/name="([a-f0-9]{32})"[^>]*value="1"/i)?.[1];
  assert.ok(token, 'The real site login form must issue a CSRF token.');
  const response = await runtime.request('index.php?option=com_users&task=user.login', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: administrator.username, password: administrator.password,
      option: 'com_users', task: 'user.login', [token]: '1' }).toString(),
  });
  await response.arrayBuffer();
  assert.ok(response.status >= 200 && response.status < 400);
  assert.match(await page(runtime, 'index.php?option=com_users&view=login'), /user\.logout/);
}

for (const major of ['5', '6']) {
  test(`Joomla ${major}: real multilingual provisioning, saved login/logout, portable snapshot restoration`, { timeout: 600_000 }, async () => {
    let runtime;
    let restored;
    try {
      runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: major === '5' ? '8.3' : '8.4' });
      const catalog = parseCatalog(runtime.manifest);
      const release = catalog.joomla.find((item) => item.version.startsWith(`${major}.`));
      assert.ok(release, `The built artifact must stage Joomla ${major}.`);
      const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
      const deployCatalog = await loadDeployCatalog({
        url: new URL(runtime.manifest.deploys.url, manifestURL), fetcher: runtime.fetchAsset,
      });
      const { configuration } = await resolveDeployConfiguration({
        deployId: 'heritage-demo', joomlaVersion: release.version,
        phpVersion: runtime.phpVersion, fresh: true, persistence: false,
        admin: { name: 'Integration Administrator', username: 'admin', email: 'admin@example.test', password: `Integration-${crypto.randomUUID()}!` },
      }, { catalog, deployCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset });
      const archive = await runtime.fetchAsset(new URL(release.url, manifestURL));
      assert.equal(archive.status, 200);
      const options = { sourceLoader, fetchPackage: runtime.fetchAsset };
      const installed = await installJoomla(runtime, configuration, {
        ...options, archiveBytes: await archive.arrayBuffer(), sha256: release.sha256,
      });
      assert.equal(installed.resumed, false);
      assert.equal(installed.deployId, 'heritage-demo');
      assert.equal(installed.language, 'af-ZA');
      for (const [kind, path] of [['model', '/administrator/components/com_config/src/Model/ApplicationModel.php'], ['console', '/libraries/src/Console/SetConfigurationCommand.php']]) {
        const bytes = await runtime.fs.readFile(runtime.documentRoot + path);
        const source = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
        assert.equal((await managedDatabaseSource(source, release.version, kind)).changed, false);
        await assert.rejects(managedDatabaseSource(source + '\n', release.version, kind), /reviewed/);
      }
      assert.match(await page(runtime, 'index.php?lang=en'), /Stories connect generations/);
      assert.match(await page(runtime, 'index.php'), /mod-languages/);
      assert.match(await page(runtime, 'index.php?lang=nl'), /Verhalen verbinden generaties/);
      assert.ok(await runtime.fs.stat('/persist/meta/administrator.json'));
      assert.equal(await runtime.fs.stat('/persist/www/meta/administrator.json'), null);

      await loginSite(runtime, installed.administrator);
      const loggedOut = await installJoomla(runtime, { ...configuration, autoLogin: false }, options);
      assert.equal(loggedOut.resumed, true);
      assert.match(await page(runtime, 'administrator/index.php'), /name="passwd"/);
      assert.match(await page(runtime, 'index.php?option=com_users&view=login'), /name="password"/);
      const resumed = await installJoomla(runtime, {
        ...configuration, language: 'nl-NL', jcbVersion: `${major}.99.0`,
        jcbPackage: { url: 'https://unavailable.example.test/never-download-on-resume.zip' },
        admin: { ...configuration.admin, password: `Unused-${crypto.randomUUID()}!` },
      }, options);
      assert.equal(resumed.administrator.password, installed.administrator.password);
      assert.equal(resumed.language, 'nl-NL');
      assert.equal(resumed.jcbInstalled, false, 'Ordinary resume reports the installed extensions, without applying a selected upgrade.');
      assert.equal(resumed.jcbVersion, 'none');
      const administratorPage = await page(runtime, 'administrator/index.php');
      assert.doesNotMatch(administratorPage, /name="passwd"/);
      assert.match(administratorPage, /lang="nl-nl"/i);
      await assert.rejects(installJoomla(runtime, { ...configuration, joomlaVersion: major === '5' ? '6.2.0' : '5.4.10' }, options), /another Joomla release/);

      await runStartupCommand(runtime, ['config:set', 'sitename=Native configuration save'], options);
      assert.equal((await readJoomlaMetadata(runtime, options)).siteName, 'Native configuration save');
      await assert.rejects(runStartupCommand(runtime, ['config:set', 'db=external_database'], options), /browser manages the database/);
      assert.equal((await readJoomlaMetadata(runtime, options)).siteName, 'Native configuration save');

      const discovered = await discoverJoomlaConfiguration(runtime, options);
      assert.ok(discovered.menuTypes.some((item) => item.component === 'com_content' && item.view === 'featured'));
      const cassiopeia = discovered.templates.find((item) => item.template === 'cassiopeia');
      assert.ok(cassiopeia);
      assert.ok(cassiopeia.schema.properties.params.properties.brand, 'Installed template fields must load from the native config XML.');
      assert.equal(cassiopeia.schema.properties.params.properties.fluidContainer.oneOf.length, 2);
      const { content: originalContent, ...legacyMarker } = (await inspectJoomla(runtime, options)).marker;
      await runtime.fs.writeFile('/persist/meta/joomla-install.json', JSON.stringify(legacyMarker));
      const content = structuredClone(configuration.content);
      content.categories[0].title = 'Edited heritage category';
      content.categories[0].alias = 'edited-heritage-category';
      content.articles[0].title = 'Edited heritage article';
      content.articles[0].alias = 'edited-heritage-article';
      content.articles[0].introtext = '<p>Saved through Configure a deployment.</p>';
      content.categories.push({ key: 'extra-news', title: 'Extra news', alias: 'extra-news', language: 'en-GB' });
      content.articles.push({ key: 'extra-article', title: 'Extra article', alias: 'extra-article', language: 'en-GB',
        category: 'extra-news', introtext: '<p>Created through Apply.</p>', fulltext: '', featured: false, home: false });
      const changes = normalizeConfiguration({ ...configuration, language: 'nl-NL', siteName: 'Configured heritage', extensions: [], startupCommands: [],
        content,
        menus: [{ key: 'featured-demo', title: 'Featured demo', alias: 'featured-demo', component: 'com_content', view: 'featured', home: true }],
        template: { element: 'cassiopeia', params: { fluidContainer: 1 } } }, { catalog, baseURL: runtime.assetBaseUrl });
      const edited = deploymentConfigurationChanges(configuration, changes);
      const configured = await applyJoomlaConfiguration(runtime, edited.configuration, { ...options, configureLanguage: edited.configureLanguage });
      assert.equal(configured.siteName, 'Configured heritage');
      assert.ok(configured.menus['featured-demo'] > 0);
      const again = await applyJoomlaConfiguration(runtime, changes, { ...options, installPackages: false });
      assert.equal(again.menus['featured-demo'], configured.menus['featured-demo'], 'Applying the same menu updates it rather than duplicating it.');
      const savedContent = (await inspectJoomla(runtime, options)).marker.content;
      for (const kind of ['categories', 'articles']) {
        for (const [key, id] of Object.entries(originalContent[kind])) assert.equal(savedContent[kind][key], id, `${kind}/${key} must retain its native ID.`);
        assert.equal(Object.keys(savedContent[kind]).length, Object.keys(originalContent[kind]).length + 1);
      }
      const article = await captureJoomlaData(runtime, { kind: 'record', component: 'com_content', view: 'article', id: savedContent.articles[content.articles[0].key] }, options);
      assert.equal(article.overlay.fields.title, content.articles[0].title);
      assert.equal(article.overlay.fields.alias, content.articles[0].alias);
      assert.equal(article.overlay.fields.introtext, content.articles[0].introtext);
      const added = await captureJoomlaData(runtime, { kind: 'record', component: 'com_content', view: 'article', id: savedContent.articles['extra-article'] }, options);
      assert.match(added.overlay.fields.introtext, /Created through Apply/);
      const after = await discoverJoomlaConfiguration(runtime, options);
      assert.equal(after.menus.filter((item) => item.alias === 'featured-demo').length, 1);
      assert.equal(Number(after.menus.find((item) => item.alias === 'featured-demo').home), 1);
      assert.equal(after.templates.filter((item) => String(item.home) === '1').length, 1);
      await page(runtime, `index.php?option=com_content&view=featured&Itemid=${configured.menus['featured-demo']}`);

      const assignment = { ...changes, template: { ...changes.template, menuKeys: ['featured-demo'] } };
      const delta = deploymentConfigurationChanges(changes, assignment);
      assert.deepEqual(delta.configuration.menus, []);
      assert.equal(delta.configuration.content, null);
      const assigned = await applyJoomlaConfiguration(runtime, delta.configuration, { ...options, configureLanguage: delta.configureLanguage });
      assert.equal(assigned.menus['featured-demo'], configured.menus['featured-demo'], 'Template assignment finds the unchanged installed menu.');
      const menu = await captureJoomlaData(runtime, { kind: 'record', component: 'com_menus', view: 'item', id: configured.menus['featured-demo'] }, options);
      assert.equal(Number(menu.overlay.fields.template_style_id), assigned.templateStyle);

      const renamed = { ...assignment, menus: assignment.menus.map(item => ({ ...item, title: 'Renamed featured menu', alias: 'renamed-featured-menu' })) };
      const renameDelta = deploymentConfigurationChanges(assignment, renamed);
      const renamedResult = await applyJoomlaConfiguration(runtime, renameDelta.configuration, { ...options, configureLanguage: renameDelta.configureLanguage });
      assert.equal(renamedResult.menus['featured-demo'], configured.menus['featured-demo'], 'Changing title and alias updates the same installed menu.');
      const renamedMenus = (await discoverJoomlaConfiguration(runtime, options)).menus;
      assert.equal(renamedMenus.length, after.menus.length, 'Renaming a deployment menu must not create a duplicate.');
      assert.equal(renamedMenus.filter(item => item.alias === 'featured-demo').length, 0);
      const renamedMenu = renamedMenus.find(item => item.alias === 'renamed-featured-menu');
      assert.equal(Number(renamedMenu.id), configured.menus['featured-demo']);
      assert.equal(renamedMenu.title, 'Renamed featured menu');
      const renamedRecord = await captureJoomlaData(runtime, { kind: 'record', component: 'com_menus', view: 'item', id: configured.menus['featured-demo'] }, options);
      assert.equal(Number(renamedRecord.overlay.fields.template_style_id), assigned.templateStyle, 'Renaming a menu must retain its template assignment.');

      const globalHome = renamedMenus.find(item => item.language === '*' && Number(item.home) === 1);
      assert.ok(globalHome);
      let languageConfiguration = renamed;
      for (const multilingual of [false, true]) {
        const next = normalizeConfiguration({ ...languageConfiguration, multilingual }, { catalog, baseURL: runtime.assetBaseUrl });
        const languageDelta = deploymentConfigurationChanges(languageConfiguration, next);
        assert.equal(languageDelta.configuration.content.multilingual, multilingual, 'The real form toggle includes normalized content.');
        await applyJoomlaConfiguration(runtime, languageDelta.configuration, { ...options, configureLanguage: languageDelta.configureLanguage });
        const plugin = await captureJoomlaData(runtime, { kind: 'plugin', folder: 'system', element: 'languagefilter' }, options);
        assert.equal(Number(plugin.overlay.fields.enabled), multilingual ? 1 : 0, 'The multilingual setting must reach the installed language plugin.');
        const toggledMenus = (await discoverJoomlaConfiguration(runtime, options)).menus;
        assert.equal(toggledMenus.find(item => item.language === '*' && Number(item.home) === 1)?.id, globalHome.id, 'Toggling multilingual mode preserves the global home page.');
        const toggledContent = (await inspectJoomla(runtime, options)).marker.content;
        assert.deepEqual(toggledContent.menus, savedContent.menus, 'Toggling multilingual mode preserves each content home ID.');
        for (const [tag, id] of Object.entries(savedContent.menus)) {
          const home = toggledMenus.find(item => Number(item.id) === id);
          assert.equal(home?.language, tag, 'Tagged home pages retain their language when multilingual mode is disabled.');
          assert.equal(Number(home.home), 1);
        }
        languageConfiguration = next;
      }

      const exported = await runtime.withExclusive((raw) => exportSite(raw, {}, { sourceLoader: exportSource }));
      assert.equal(exported.metadata.joomlaVersion, release.version);
      await runtime.close();
      runtime = undefined;
      restored = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: major === '5' ? '8.4' : '8.5' });
      const restoredConfiguration = {
        ...configuration, language: 'nl-NL', siteName: 'Restored heritage',
        admin: { ...configuration.admin, username: 'restored', password: `Restored-${crypto.randomUUID()}!` },
        addonStartupCommands: [['cache:clean']],
      };
      await assert.rejects(importJoomlaSnapshot(restored, restoredConfiguration, {
        sourceLoader, archiveBytes: exported.bytes, sha256: '0'.repeat(64),
      }), /SHA-256 verification/);
      assert.equal((await inspectJoomla(restored, { sourceLoader })).marker, null, 'A checksum failure must not start importing.');
      const imported = await importJoomlaSnapshot(restored, restoredConfiguration, {
        sourceLoader, fetchPackage: restored.fetchAsset, archiveBytes: exported.bytes, sha256: await sha256(exported.bytes),
      });
      assert.equal(imported.fromSnapshot, true);
      assert.equal(imported.resumed, false);
      assert.equal(imported.siteName, 'Restored heritage');
      assert.equal(imported.administrator.username, 'restored');
      assert.equal(imported.administrator.password, restoredConfiguration.admin.password);
      assert.equal((await readJoomlaMetadata(restored, { sourceLoader })).language, 'nl-NL');
      assert.match(await page(restored, 'index.php?lang=nl'), /Verhalen verbinden generaties/);
      assert.doesNotMatch(await page(restored, 'administrator/index.php'), /name="passwd"/);
      await assert.rejects(importJoomlaSnapshot(restored, restoredConfiguration, {
        sourceLoader, archiveBytes: exported.bytes, sha256: await sha256(exported.bytes),
      }), /fresh playground/);
    } finally {
      await runtime?.close();
      await restored?.close();
    }
  });
}
