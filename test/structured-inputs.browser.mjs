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
      await page.locator('#content-fields').getByRole('button', { name: 'Add article', exact: true }).click();
      const article = page.locator('#content-fields .deployment-card').nth(1);
      await article.getByRole('textbox', { name: 'Title', exact: true }).fill('Welcome');
      const content = await page.evaluate(() => window.content.read());
      assert.equal(content.categories[0].title, 'News');
      assert.equal(content.articles[0].alias, 'welcome');
      assert.equal(content.articles[0].category, content.categories[0].key);
      assert.equal(content.articles[0].introtext, '');

      await page.locator('#menus-fields').getByRole('button', { name: 'Add menu item', exact: true }).click();
      await page.locator('#menus-fields').getByRole('textbox', { name: 'Title', exact: true }).fill('Read news');
      await page.locator('#menus-fields').getByRole('spinbutton', { name: 'Article number', exact: true }).fill('7');
      assert.equal(await page.evaluate(() => window.menus.read()[0].query.id), 7);
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

      // An unfinished JSON draft cannot be replaced by old form controls.
      await page.getByText('parameters JSON', { exact: true }).click();
      await page.locator('#parameters-json').fill('{"unfinished":');
      assert.equal(await page.locator('#parameters-fields input').first().isDisabled(), true);
      await page.evaluate(() => window.parameters.refresh());
      assert.equal(await page.locator('#parameters-json').inputValue(), '{"unfinished":');
      assert.ok(await page.evaluate(() => { try { window.parameters.read(); return false; } catch { return true; } }));
      const restored = { title: 'Restored', nested: { retained: [1, 'two', false, null] } };
      await page.locator('#parameters-json').fill(JSON.stringify(restored));
      assert.deepEqual(await page.evaluate(() => window.parameters.read()), restored);
      assert.equal(await page.locator('#parameters-fields input').first().isDisabled(), false);
    } finally {
      try { await browser?.close(); } finally { await server.close(); }
    }
  });
}
