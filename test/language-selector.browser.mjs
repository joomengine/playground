import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`language combobox supports catalog, keyboard and custom multi-selection (${name})`, { timeout: 45_000 }, async () => {
    const server = await createStaticServer({ directory });
    let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.url}__test__.html`);
      await page.evaluate(async () => {
        const { createLanguageSelector } = await import('./src/language-selector.mjs');
        document.querySelector('main').innerHTML = '<form><label for="language">Joomla language</label><input id="language" value="en-GB" required><label for="languages">Site languages</label><input id="languages" value="en-GB"><button id="submit" type="submit">Launch</button></form>';
        const style = document.createElement('style'); style.textContent = '.language-options[hidden]{display:none}.language-option{padding:8px;cursor:pointer}.language-input-row{display:flex}.language-tags{display:flex;gap:8px}.language-note{font-size:12px}'; document.head.append(style);
        const messages = { 'language.show': 'Show available languages', 'language.add': 'Add a language', 'language.invalid': 'Use a valid Joomla language tag.',
          'language.remove': 'Remove {tag}', 'language.custom': 'Use custom tag {tag}', 'language.customPackage': 'Custom language: {tags}. Configure its package before launch.',
          'language.singleHelp': 'Choose or type a language', 'language.multipleHelp': 'Choose languages and press Enter', 'language.noMatches': 'No catalog matches', 'language.limit': 'At most 30 languages' };
        const t = (key, values = {}) => (messages[key] || key).replace(/\{(\w+)\}/g, (_, key) => values[key] || '');
        window.languageEvents = []; window.languageSubmissions = 0;
        document.querySelector('form').addEventListener('change', event => window.languageEvents.push({ id: event.target.id, value: event.target.value }));
        document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.languageSubmissions++; });
        window.singleLanguage = createLanguageSelector(document.getElementById('language'), { t });
        window.multiLanguage = createLanguageSelector(document.getElementById('languages'), { t, multiple: true });
        for (const selector of [window.singleLanguage, window.multiLanguage]) selector.setCatalog(['af-ZA', 'fr-FR', 'de-DE']);
      });
      const single = page.locator('#language');
      await single.focus();
      assert.equal(await page.locator('#language-choices').isVisible(), true);
      assert.equal(await page.locator('#language-choices [role="option"]').count(), 4, 'Existing values do not hide the catalog when focused.');
      await single.fill('French');
      assert.equal(await page.locator('#language-choices [role="option"]').count(), 1);
      await single.press('ArrowDown');
      const selectedId = await single.getAttribute('aria-activedescendant');
      assert.ok(selectedId);
      assert.equal(await page.locator(`#${selectedId}`).getAttribute('aria-selected'), 'true');
      await single.press('Enter');
      assert.equal(await single.inputValue(), 'fr-FR');
      assert.equal(await single.getAttribute('aria-expanded'), 'false');
      await single.fill('zh-hant-tw');
      await single.press('Enter');
      assert.equal(await single.inputValue(), 'zh-Hant-TW');
      assert.match(await page.locator('#language-note').innerText(), /Configure its package/);
      assert.equal(await single.evaluate(input => input.checkValidity()), true);
      await single.fill('invalid');
      assert.equal(await single.evaluate(input => input.checkValidity()), false);
      await single.fill('en-GB');
      await single.press('Enter');

      const multi = page.locator('#languages-entry');
      await multi.focus();
      assert.equal(await page.locator('#languages-choices [role="option"]').count(), 3, 'Already selected English is excluded.');
      await multi.fill('de'); await multi.press('ArrowDown'); await multi.press('Enter');
      assert.equal(await page.locator('#languages').inputValue(), 'en-GB, de-DE');
      assert.equal(await page.locator('.language-tag').count(), 2);
      await multi.fill('sr-latn-rs');
      assert.equal(await page.locator('#languages').inputValue(), 'en-GB, de-DE, sr-Latn-RS', 'Pending custom text is available to configuration actions before blur.');
      await multi.press('Enter');
      assert.equal(await page.locator('.language-tag').count(), 3);
      await page.getByRole('button', { name: 'Remove de-DE', exact: true }).click();
      assert.equal(await page.locator('#languages').inputValue(), 'en-GB, sr-Latn-RS');
      await multi.fill('af-za, fr-fr'); await multi.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('language-toggle')), true,
        'Tab moves to the dropdown button within the same widget.');
      assert.equal(await page.locator('#languages').inputValue(), 'en-GB, sr-Latn-RS, af-ZA, fr-FR');
      assert.equal(await multi.inputValue(), '', 'Leaving the entry commits valid pasted tags.');
      assert.equal(await page.locator('.language-tag').count(), 4);
      await multi.fill('invalid'); await multi.press('Tab');
      assert.equal(await multi.inputValue(), 'invalid', 'Invalid pending text stays editable after blur.');
      assert.equal(await multi.evaluate(input => input.checkValidity()), false);
      assert.equal(await page.locator('.language-tag').count(), 4, 'Invalid text is never promoted to a selected tag.');
      await multi.fill('fr-FR'); await multi.press('Tab');
      assert.equal(await page.locator('#languages').inputValue(), 'en-GB, sr-Latn-RS, af-ZA, fr-FR');
      assert.equal(await page.locator('.language-tag').count(), 4, 'Committing a repeated tag does not duplicate it.');
      await page.evaluate(() => { document.getElementById('languages').value = 'de-DE'; window.multiLanguage.refresh(); });
      assert.equal(await page.locator('.language-tag').count(), 1);
      assert.equal(await page.locator('.language-tag').innerText(), 'de-DE×');
      await multi.focus(); await multi.press('Escape');
      assert.equal(await multi.getAttribute('aria-expanded'), 'false');
      await page.locator('#submit').click();
      assert.equal(await page.evaluate(() => window.languageSubmissions), 1);
      const events = await page.evaluate(() => window.languageEvents);
      assert.ok(events.some(event => event.id === 'language' && event.value === 'fr-FR'));
      assert.ok(events.some(event => event.id === 'languages' && event.value.includes('sr-Latn-RS')));
      await page.evaluate(() => { window.singleLanguage.dispose(); window.multiLanguage.dispose(); });
      assert.equal(await page.locator('.language-selector').count(), 0);
      assert.equal(await page.locator('#languages').getAttribute('type'), 'text');
      assert.equal(await page.locator('label[for="languages"]').count(), 1);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
