import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

for (const browserName of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`deployment schema forms edit content, settings and JSON without data loss (${browserName})`, { timeout: 60_000 }, async () => {
    const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)) });
    let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${browserName.toUpperCase()}_EXECUTABLE`];
      browser = await { chromium, firefox }[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(`${server.url}__test__.html`);
      await page.evaluate(async () => {
        const { createStructuredInputs } = await import('./src/structured-inputs.mjs');
        const { loadDeploymentFormSchemas } = await import('./src/deployment-form-schema.mjs');
        const schemas = await loadDeploymentFormSchemas();
        const main = document.querySelector('main');
        for (const kind of ['commands', 'parameters', 'menus', 'content', 'overlays']) {
          const container = document.createElement('div'); container.id = `${kind}-fields`;
          const advanced = document.createElement('details');
          const summary = document.createElement('summary'); summary.textContent = `${kind} JSON`;
          const textarea = document.createElement('textarea'); textarea.id = `${kind}-json`;
          const errorElement = document.createElement('p'); errorElement.id = `${kind}-error`;
          advanced.append(summary, textarea); main.append(container, advanced, errorElement);
          window[kind] = createStructuredInputs({ textarea, container, advanced, errorElement, kind, schema: schemas[kind] });
        }
        window.commands.setValue([['config:set', 'sitename', 'Original']]);
        window.parameters.setSchema({ type: 'object', properties: { title: { type: 'string', title: 'Template title' }, count: { type: 'number', title: 'Count' } } });
        window.parameters.setValue({ title: 'Original', count: 3, future: { kept: [false, null, 'item'] } });
        window.content.setValue(null);
        window.menus.setContext({ menuTypes: [{ component: 'com_content', view: 'article', layout: 'default', title: 'Single article', fields: [{ name: 'id', group: 'query', type: 'integer', label: 'Article number', required: true }] }] });
      });

      // Arguments keep whitespace and line breaks, and form fields preserve unknown JSON.
      await page.locator('#commands-fields').getByRole('textbox', { name: 'Argument 2', exact: true }).fill('  exact "quoted" value\nsecond line  ');
      assert.deepEqual(await page.evaluate(() => window.commands.read()), [['config:set', 'sitename', '  exact "quoted" value\nsecond line  ']]);
      await page.locator('#parameters-fields').getByRole('textbox', { name: 'Template title', exact: true }).fill('Updated');
      assert.deepEqual(await page.evaluate(() => window.parameters.read()), { title: 'Updated', count: 3, future: { kept: [false, null, 'item'] } });
      assert.deepEqual(await page.evaluate(() => {
        const original = document.activeElement;
        document.activeElement.setSelectionRange(1, 4);
        window.parameters.setContext({ language: 'en-GB' });
        return [document.activeElement === original, document.activeElement.getAttribute('aria-label'), document.activeElement.selectionStart, document.activeElement.selectionEnd];
      }), [true, 'Template title', 1, 4]);
      const count = page.locator('#parameters-fields').getByRole('spinbutton', { name: 'Count', exact: true });
      await count.fill(''); await count.press('-');
      assert.ok(await page.evaluate(() => { try { window.parameters.read(); return false; } catch { return true; } }));
      await page.evaluate(() => window.parameters.setContext({ language: 'en-GB' }));
      await count.fill('4.25');
      assert.equal(await page.evaluate(() => window.parameters.read().count), 4.25);

      // Categories/articles use titles, suggested aliases and a category picker.
      assert.equal(await page.evaluate(() => window.content.read()), null);
      await page.locator('#content-fields').getByRole('button', { name: 'Add category', exact: true }).click();
      const category = page.locator('#content-fields .deployment-card').first();
      await category.getByRole('textbox', { name: 'Title', exact: true }).fill('News');
      assert.equal(await category.getByRole('textbox', { name: 'URL name', exact: true }).inputValue(), 'news');
      const originalCategory = await category.getByRole('textbox', { name: 'Title', exact: true }).elementHandle();
      await page.locator('#content-fields').getByRole('button', { name: 'Add article', exact: true }).click();
      assert.equal(await originalCategory.evaluate(control => control.isConnected), true, 'Adding an article preserves the existing category controls.');
      const article = page.locator('#content-fields .deployment-card').nth(1);
      await article.getByRole('textbox', { name: 'Title', exact: true }).fill('Welcome');
      const content = await page.evaluate(() => window.content.read());
      assert.equal(content.categories[0].title, 'News');
      assert.equal(content.articles[0].alias, 'welcome');
      assert.equal(content.articles[0].category, content.categories[0].key);
      assert.equal(content.articles[0].introtext, '');
      assert.deepEqual(await category.getByRole('combobox', { name: 'Language', exact: true }).evaluate(control => [...control.list.options].map(option => option.value)), ['en-GB']);

      await page.locator('#menus-fields').getByRole('button', { name: 'Add menu item', exact: true }).click();
      await page.locator('#menus-fields').getByRole('combobox', { name: 'Page type', exact: true }).selectOption({ label: 'Single article' });
      await page.locator('#menus-fields').getByRole('textbox', { name: 'Title', exact: true }).fill('Read news');
      await page.locator('#menus-fields').getByRole('spinbutton', { name: 'Article number', exact: true }).fill('7');
      assert.equal(await page.evaluate(() => window.menus.read()[0].query.id), 7);
      const firstMenu = await page.locator('#menus-fields').getByRole('textbox', { name: 'Title', exact: true }).elementHandle();
      await page.locator('#menus-fields').getByRole('button', { name: 'Add menu item', exact: true }).click();
      const secondMenu = page.locator('#menus-fields .deployment-card').nth(1);
      await secondMenu.getByRole('textbox', { name: 'Title', exact: true }).fill('Second menu');
      assert.equal(await firstMenu.evaluate(control => control.isConnected), true);
      await secondMenu.getByRole('button', { name: 'Move up', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.menus.read().map(item => item.title)), ['Second menu', 'Read news']);
      assert.equal(await firstMenu.evaluate(control => control.isConnected), true, 'Moving a menu retains the other menu controls.');
      await page.locator('#menus-fields .deployment-card').nth(1).getByRole('button', { name: /^Remove / }).click();
      await page.locator('#menus-fields').getByRole('textbox', { name: 'Title', exact: true }).fill('Renamed after removal');
      assert.deepEqual(await page.evaluate(() => window.menus.read().map(item => item.title)), ['Renamed after removal']);
      await page.evaluate(() => {
        window.menus.setContext({ menuTypes: [] });
        window.menus.setValue([{ title: 'Directory', component: 'com_service_directory', view: 'directory', query: { existing: 'kept' } }]);
      });
      assert.equal(await page.locator('#menus-fields').getByRole('combobox', { name: 'Page type', exact: true }).locator('option:checked').textContent(), 'Service directory · Directory');
      assert.equal(await page.locator('#menus-fields').getByRole('textbox', { name: 'Component', exact: true }).isVisible(), false);
      assert.equal(await page.evaluate(() => window.menus.read()[0].query.existing), 'kept');
      assert.equal(await page.getByRole('option', { name: /^(?:Array|Object|String)$/ }).count(), 0);

      // The verified offline Repository form supports GUID-only patches and masks tokens.
      await page.locator('#overlays-fields').getByRole('button', { name: 'Add configuration', exact: true }).click();
      const guid = '11111111-1111-4111-8111-111111111111';
      await page.locator('#overlays-fields').getByRole('textbox', { name: 'Record GUID', exact: true }).fill(guid);
      assert.deepEqual(await page.evaluate(() => window.overlays.read()[0].fields), {});
      await page.locator('#overlays-fields').getByRole('textbox', { name: 'Repository name', exact: true }).fill('Private packages');
      const token = page.locator('#overlays-fields input[type="password"]');
      await token.fill('temporary-token');
      assert.equal(await page.evaluate(() => window.overlays.read()[0].fields.token), 'temporary-token');
      const capture = await page.evaluate(() => {
        const first = window.overlays.read()[0];
        window.overlays.append({ ...first, key: 'captured-repository', fields: { organisation: 'team' } });
        window.overlays.append({ key: 'dependent', kind: 'record', component: 'com_example', view: 'record', fields: { repository: { $ref: 'captured-repository', field: 'guid' } }, dependsOn: ['captured-repository'] });
        return window.overlays.read();
      });
      assert.equal(capture.length, 2);
      assert.equal(capture[0].fields.system_name, 'Private packages');
      assert.equal(capture[0].fields.organisation, 'team');
      assert.equal(capture[1].fields.repository.$ref, capture[0].key);
      assert.deepEqual(capture[1].dependsOn, [capture[0].key]);
      await page.evaluate(() => window.overlays.append({ key: 'remote-snippet', kind: 'record', component: 'com_componentbuilder', view: 'snippet', guid: '22222222-2222-4222-8222-222222222222', fields: {} }));
      await page.locator('#overlays-fields').getByRole('combobox', { name: 'Repository · Linked configuration', exact: true }).selectOption({ label: 'Private packages' });
      assert.deepEqual(await page.evaluate(() => window.overlays.read().at(-1).source.repository), { $ref: capture[0].key, field: 'guid' });
      await page.evaluate(() => window.overlays.setValue([{ key: 'custom-module', kind: 'module', element: 'mod_custom', clientId: 0, fields: { title: 'Original' },
        schema: { type: 'object', properties: { title: { type: 'string', title: 'Module title' } } },
      }]));
      await page.locator('#overlays-fields').getByRole('textbox', { name: 'Module title', exact: true }).fill('Updated module');
      assert.deepEqual(await page.evaluate(() => window.overlays.read()[0].fields), { title: 'Updated module' });
      assert.equal(await page.evaluate(() => {
        const original = document.activeElement;
        window.overlays.setRecordSchema({ kind: 'module', element: 'mod_custom', clientId: 0 }, {
          type: 'object', properties: { title: { type: 'string', title: 'Module title' }, note: { type: 'string', title: 'Module note' } },
        });
        return document.activeElement === original && original.isConnected;
      }), true, 'A late record schema cannot replace the field being edited.');
      await page.evaluate(() => {
        window.parameters.setSchema({ type: 'object', properties: { key: { type: 'string', title: 'Template key' } } });
        window.parameters.setValue({ key: 'Original' });
      });
      await page.locator('#parameters-fields').getByRole('textbox', { name: 'Template key', exact: true }).fill('Updated key');
      assert.deepEqual(await page.evaluate(() => window.parameters.read()), { key: 'Updated key' });
      const nativeSubform = await page.evaluate(() => {
        window.parameters.setSchema({ type: 'object', properties: { rows: { type: 'array', title: 'Placeholders', items: { type: 'object', properties: { name: { type: 'string', title: 'Placeholder name' } } } } } });
        window.parameters.setValue({ rows: { row0: { name: 'ORIGINAL' } } });
        return window.parameters.read();
      });
      assert.deepEqual(nativeSubform, { rows: { row0: { name: 'ORIGINAL' } } });
      await page.locator('#parameters-fields').getByRole('textbox', { name: 'Placeholder name', exact: true }).fill('UPDATED');
      assert.deepEqual(await page.evaluate(() => window.parameters.read()), { rows: { row0: { name: 'UPDATED' } } });
      assert.deepEqual(await page.evaluate(async () => {
        const { siteParameters } = await import('./src/site-configuration.mjs');
        return siteParameters(window.parameters.read());
      }), { rows: { row0: { name: 'UPDATED' } } }, 'Edited native subforms are accepted by the runtime parser.');
      await page.evaluate(() => window.parameters.setValue({}));
      await page.locator('#parameters-fields').getByRole('button', { name: 'Add configuration', exact: true }).click();
      await page.locator('#parameters-fields').getByRole('textbox', { name: 'Placeholder name', exact: true }).fill('NEW');
      assert.deepEqual(await page.evaluate(async () => {
        const { siteParameters } = await import('./src/site-configuration.mjs');
        return siteParameters(window.parameters.read());
      }), { rows: { row0: { name: 'NEW' } } }, 'New template subforms use the same keyed-row contract.');
      await page.evaluate(() => {
        window.parameters.setSchema({ type: 'object', properties: { title: { type: 'string', title: 'Template title' } } });
        window.parameters.setValue({ title: 'Updated' });
      });

      // An unfinished JSON draft cannot be replaced by old form controls.
      await page.getByText('parameters JSON', { exact: true }).click();
      const beforeJson = await page.locator('#parameters-fields input').first().elementHandle();
      await page.locator('#parameters-json').fill('{"unfinished":');
      assert.equal(await page.locator('#parameters-fields').isHidden(), true);
      assert.equal(await beforeJson.evaluate(control => control.isConnected), true, 'Typing JSON does not rebuild the form.');
      await page.evaluate(() => window.parameters.refresh());
      assert.equal(await page.locator('#parameters-json').inputValue(), '{"unfinished":');
      assert.ok(await page.evaluate(() => { try { window.parameters.read(); return false; } catch { return true; } }));
      const restored = { title: 'Restored', nested: { retained: [1, 'two', false, null] } };
      await page.locator('#parameters-json').fill(JSON.stringify(restored));
      await page.getByText('parameters JSON', { exact: true }).click();
      await page.locator('#parameters-fields').waitFor({ state: 'visible' });
      assert.deepEqual(await page.evaluate(() => window.parameters.read()), restored);
      assert.equal(await page.locator('#parameters-fields').isVisible(), true);

      // Schema regex keeps its own semantics and never becomes an invalid HTML pattern.
      await page.evaluate(() => {
        window.parameters.setSchema({ type: 'object', properties: {
          slug: { type: 'string', title: 'Pattern key', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
          fragment: { type: 'string', title: 'Pattern fragment', pattern: '[a-z]+' },
        } });
        window.parameters.setValue({ slug: 'valid-key', fragment: '12abc34' });
      });
      assert.deepEqual(await page.evaluate(() => window.parameters.read()), { slug: 'valid-key', fragment: '12abc34' });
      const key = page.getByRole('textbox', { name: 'Pattern key', exact: true });
      assert.equal(await key.getAttribute('pattern'), null);
      await key.fill('INVALID');
      assert.equal(await key.evaluate(control => control.validity.valid), false);
      await key.fill('valid-again');
      assert.equal(await key.evaluate(control => control.validity.valid), true);
      assert.deepEqual(errors, []);
    } finally {
      try { await browser?.close(); } finally { await server.close(); }
    }
  });
}
