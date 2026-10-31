import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const checksum = 'a'.repeat(64);

for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`extension URLs and advanced JSON preserve edits and remain usable (${name})`, { timeout: 60_000 }, async () => {
    const server = await createStaticServer({ directory });
    let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.url}__test__.html`);
      await page.addStyleTag({ url: `${server.url}src/styles.css` });
      await page.addStyleTag({ content: 'main{display:block;max-width:720px;margin:auto;padding:16px}form{min-width:0}' });
      await page.evaluate(async () => {
        const { createExtensionInputs } = await import('./src/extension-inputs.mjs');
        const { t } = await import('./src/i18n.mjs');
        document.querySelector('main').innerHTML = `
          <form id="extension-form">
            <section class="extension-packages" aria-labelledby="extension-title">
              <h3 id="extension-title">Extension packages</h3>
              <p id="extension-url-help">Paste a package URL.</p>
              <div id="package-list" class="extension-url-list"></div>
              <button id="add-package" class="button button-secondary" type="button">Add another URL</button>
              <details id="extension-advanced" class="extension-advanced"><summary>Advanced options</summary>
                <div class="field"><label for="extensions">Extension packages JSON</label>
                <textarea id="extensions" rows="5" aria-describedby="extensions-help">[]</textarea>
                <p id="extensions-help">A JSON array of package objects.</p></div>
              </details>
              <p id="extension-error" class="dialog-error" role="alert" hidden></p>
            </section>
            <button id="submit" type="submit">Use deployment</button>
          </form>`;
        window.extensionSubmissions = 0;
        window.extensionChanges = 0;
        window.extensionInputs = createExtensionInputs({
          textarea: document.getElementById('extensions'), rows: document.getElementById('package-list'),
          addButton: document.getElementById('add-package'), advanced: document.getElementById('extension-advanced'),
          errorElement: document.getElementById('extension-error'), baseURL: location.href, t,
          onChange: () => { window.extensionChanges++; },
        });
        document.getElementById('extension-form').addEventListener('submit', event => {
          event.preventDefault();
          window.extensionSubmissions++;
          window.submittedExtensions = window.extensionInputs.read();
        });
      });

      const inputs = page.locator('#package-list input[type="url"]');
      const inputValues = () => inputs.evaluateAll(nodes => nodes.map(node => node.value));
      const read = () => page.evaluate(() => window.extensionInputs.read());
      const json = page.locator('#extensions');
      const add = page.locator('#add-package');
      const advanced = page.locator('#extension-advanced');
      assert.equal(await inputs.count(), 1, 'The initial form contains an ordinary URL field.');
      assert.equal(await json.isVisible(), false, 'JSON is optional and collapsed initially.');
      assert.deepEqual(await read(), []);
      await inputs.first().fill('https://packages.example.test/first.zip');
      assert.deepEqual(await read(), [{ url: 'https://packages.example.test/first.zip' }]);
      await add.click();
      assert.equal(await inputs.count(), 2);
      assert.deepEqual(await read(), [{ url: 'https://packages.example.test/first.zip' }], 'An extra blank row is not an install instruction.');
      await inputs.nth(1).fill('http://packages.example.test/second.zip');
      assert.deepEqual(await read(), [{ url: 'https://packages.example.test/first.zip' }, { url: 'http://packages.example.test/second.zip' }]);
      await page.getByRole('button', { name: 'Remove extension URL 1', exact: true }).click();
      assert.deepEqual(await read(), [{ url: 'http://packages.example.test/second.zip' }]);
      await inputs.first().press('Enter');
      assert.equal(await page.evaluate(() => window.extensionSubmissions), 0, 'Enter in a URL field must not launch or submit a deployment.');

      for (const invalid of ['packages.example.test/missing-scheme.zip', 'ftp://packages.example.test/package.zip', 'https://']) {
        await inputs.first().fill(invalid);
        const invalidUrl = await page.evaluate(() => { try { window.extensionInputs.read(); return ''; } catch (error) { return error.message; } });
        assert.ok(invalidUrl, 'Basic entry requires a complete HTTP or HTTPS address.');
        assert.equal(await advanced.getAttribute('open'), null, 'An invalid ordinary URL must not force non-programmers into JSON.');
        assert.equal(await inputs.first().inputValue(), invalid);
        assert.equal(await page.locator('#extension-error').isVisible(), true);
      }

      await page.evaluate(checksum => window.extensionInputs.setValue([{ url: 'https://packages.example.test/original.zip', sha256: checksum }]), checksum);
      await inputs.first().focus();
      await page.evaluate(() => window.extensionInputs.refresh());
      assert.equal(await inputs.first().evaluate(input => document.activeElement === input), true, 'Refreshing labels preserves editing focus.');
      assert.deepEqual(await read(), [{ url: 'https://packages.example.test/original.zip', sha256: checksum }]);
      await advanced.locator('summary').click();
      assert.deepEqual(JSON.parse(await json.inputValue()), [{ url: 'https://packages.example.test/original.zip', sha256: checksum }]);
      const edited = [{ url: 'https://packages.example.test/json.zip', sha256: checksum }, { url: 'http://packages.example.test/another.zip' }];
      await json.fill(JSON.stringify(edited, null, 2));
      assert.deepEqual(await read(), edited);
      assert.deepEqual(await inputValues(), edited.map(entry => entry.url));
      await advanced.locator('summary').click();
      assert.equal(await json.isVisible(), false);
      await inputs.first().fill('https://packages.example.test/changed.zip');
      assert.deepEqual(await read(), [{ url: 'https://packages.example.test/changed.zip' }, edited[1]], 'A changed package URL cannot retain an unrelated checksum.');

      await advanced.locator('summary').click();
      const lastRows = await inputValues();
      const broken = '[{"url": "https://packages.example.test/unfinished.zip"';
      await json.fill(broken);
      assert.equal(await json.inputValue(), broken);
      assert.deepEqual(await inputValues(), lastRows, 'Malformed JSON does not replace the last editable package rows.');
      assert.equal(await add.isDisabled(), true);
      assert.ok((await inputs.evaluateAll(nodes => nodes.every(node => node.disabled || node.readOnly))), 'Row changes cannot overwrite malformed JSON.');
      const invalidJson = await page.evaluate(() => { try { window.extensionInputs.read(); return ''; } catch (error) { return error.message; } });
      assert.ok(invalidJson);
      await advanced.locator('summary').click();
      await page.waitForFunction(() => document.getElementById('extension-advanced').open);
      assert.equal(await json.inputValue(), broken, 'Toggling Advanced does not discard an invalid draft.');
      await json.fill('["https://packages.example.test/string-entry.zip"]');
      assert.ok(await page.evaluate(() => { try { window.extensionInputs.read(); return false; } catch { return true; } }), 'String arrays cannot silently become valid package objects.');
      await json.fill('[]');
      assert.deepEqual(await read(), []);
      assert.equal(await add.isEnabled(), true);
      assert.equal(await inputs.count(), 1);

      const limit = Array.from({ length: 30 }, (_, index) => ({ url: `https://packages.example.test/${index}.zip` }));
      await json.fill(JSON.stringify([...limit, { url: 'https://packages.example.test/too-many.zip' }]));
      assert.ok(await page.evaluate(() => { try { window.extensionInputs.read(); return false; } catch { return true; } }), 'Advanced JSON enforces the same maximum number of extensions.');
      assert.equal(await add.isDisabled(), true);
      await page.evaluate(entries => window.extensionInputs.setValue(entries), limit);
      assert.equal(await inputs.count(), 30);
      assert.equal(await add.isDisabled(), true);
      await page.getByRole('button', { name: 'Remove extension URL 30', exact: true }).click();
      assert.equal(await add.isEnabled(), true);
      assert.equal((await read()).length, 29);

      await page.evaluate(() => {
        window.extensionInputs.setValue([{ url: 'https://packages.example.test/a-long-package-name-for-a-narrow-screen.zip' }]);
        document.getElementById('extension-advanced').open = false;
        document.documentElement.dir = 'rtl';
        document.documentElement.dataset.theme = 'light';
        window.extensionInputs.refresh();
      });
      await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
      for (const width of [1200, 390, 320]) {
        await page.setViewportSize({ width, height: 640 });
        assert.equal(await inputs.first().evaluate(input => getComputedStyle(input).direction), 'ltr', 'URL text retains its reading direction within RTL interfaces.');
        assert.ok(await page.locator('#package-list').evaluate(root => {
          const box = root.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth && root.scrollWidth <= root.clientWidth + 1;
        }), `URL rows and remove controls fit a ${width}px RTL viewport.`);
        assert.ok(await page.getByRole('button', { name: 'Remove extension URL 1', exact: true }).isVisible());
      }
      await page.locator('#submit').click();
      assert.equal(await page.evaluate(() => window.extensionSubmissions), 1);
      assert.deepEqual(await page.evaluate(() => window.submittedExtensions), await read());
      assert.ok(await page.evaluate(() => window.extensionChanges > 0));
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
