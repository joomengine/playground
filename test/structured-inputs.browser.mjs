import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';
import { createStaticServer } from './server.mjs';

test('structured editors preserve arguments and nested values across basic and JSON edits', { timeout: 60_000 }, async () => {
  const server = await createStaticServer({ directory: fileURLToPath(new URL('../', import.meta.url)) });
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.PLAYGROUND_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYGROUND_CHROMIUM_EXECUTABLE } : {}),
    });
    const page = await browser.newPage();
    await page.goto(`${server.url}__test__.html`);
    await page.evaluate(async () => {
      const { createStructuredInputs } = await import('./src/structured-inputs.mjs');
      const main = document.querySelector('main');
      for (const kind of ['commands', 'parameters']) {
        const container = document.createElement('div'); container.id = `${kind}-fields`;
        const advanced = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = `${kind} JSON`;
        const textarea = document.createElement('textarea'); textarea.id = `${kind}-json`;
        const errorElement = document.createElement('p'); errorElement.id = `${kind}-error`;
        advanced.append(summary, textarea); main.append(container, advanced, errorElement);
        window[kind] = createStructuredInputs({ textarea, container, advanced, errorElement, kind });
      }
      window.commands.setValue([['config:set', 'sitename', 'A name with spaces'], ['cache:clean']]);
      window.parameters.setValue({ title: 'Old title', nested: { enabled: true, count: 3 }, choices: [false, null, 'item'] });
    });
    await page.getByRole('textbox', { name: 'Command 1 argument 2', exact: true }).fill('  exact "quoted" value\nsecond line  ');
    assert.deepEqual(await page.evaluate(() => window.commands.read()), [
      ['config:set', 'sitename', '  exact "quoted" value\nsecond line  '], ['cache:clean'],
    ]);
    await page.getByRole('button', { name: 'Add argument to command 2' }).click();
    await page.getByRole('textbox', { name: 'Command 2 argument 1', exact: true }).fill('--group=system');
    assert.equal(await page.evaluate(() => window.commands.read()[1][1]), '--group=system');

    await page.getByRole('textbox', { name: 'Parameters: Title value', exact: true }).fill('New title');
    assert.deepEqual(await page.evaluate(() => window.parameters.read()), {
      title: 'New title', nested: { enabled: true, count: 3 }, choices: [false, null, 'item'],
    });
    await page.getByRole('textbox', { name: 'Parameters: Nested: Count value', exact: true }).fill('invalid');
    assert.match(await page.evaluate(() => { try { window.parameters.read(); return ''; } catch (error) { return error.message; } }), /finite number/);
    await page.getByRole('textbox', { name: 'Parameters: Nested: Count value', exact: true }).fill('4.25');
    assert.equal(await page.evaluate(() => window.parameters.read().nested.count), 4.25);

    await page.getByText('parameters JSON', { exact: true }).click();
    await page.locator('#parameters-json').fill('{"unfinished":');
    assert.equal(await page.locator('#parameters-fields input').first().isDisabled(), true);
    assert.equal(await page.locator('#parameters-json').inputValue(), '{"unfinished":');
    assert.ok(await page.evaluate(() => { try { window.parameters.read(); return false; } catch { return true; } }));
    await page.locator('#parameters-json').fill(JSON.stringify({ nested: { retained: [1, 'two', false, null] } }));
    assert.deepEqual(await page.evaluate(() => window.parameters.read()), { nested: { retained: [1, 'two', false, null] } });
    assert.equal(await page.locator('#parameters-fields input').first().isDisabled(), false);
  } finally {
    await browser?.close();
    await server.close();
  }
});
