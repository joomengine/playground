import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createStaticServer } from './server.mjs';

test('the composed site opens its default deployment selector and protected credits', { timeout: 90_000 }, async t => {
  const directory = path.resolve(process.env.PLAYGROUND_DIST || 'dist');
  const [manifest, catalog] = await Promise.all(['assets/manifest.json', 'deploys/catalog.json'].map(
    file => readFile(path.join(directory, file), 'utf8').then(JSON.parse)));
  const server = await createStaticServer({ directory, prefix: '/fork-smoke/' });
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath: process.env.PLAYGROUND_CHROMIUM_EXECUTABLE });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'en' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '?start=0');
  await page.waitForFunction(() => document.querySelector('#activity-log')?.textContent.includes('Ready to launch')
    || document.querySelector('#error-view')?.hidden === false, undefined, { timeout: 60_000 });
  assert.equal(await page.locator('#error-view').isVisible(), false, await page.locator('#error-message').textContent());
  // Choose the starting recipe first. It may select a different compatible Joomla major.
  const hostMajor = manifest.defaults.joomlaVersion.split('.')[0];
  const expected = catalog.defaultsByJoomla?.[hostMajor] ?? catalog.default;
  assert.equal(await page.locator('#deploy').inputValue(), expected);
  const selected = catalog.deploys.find(item => item.id === expected);
  assert.ok(selected);
  assert.equal(await page.locator('#deploy option:checked').textContent(), selected.title);
  const publicProfile = await page.locator('#playground-site').allTextContents();
  const { features = {} } = publicProfile.length ? JSON.parse(publicProfile[0]) : {};
  if (features.phpVersion === false) assert.equal(await page.locator('#php-version').inputValue(), manifest.defaults.phpVersion);
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), manifest.deployment.canonicalUrl);
  const about = page.locator(features.footer === false ? '#site-credits' : '#information-button');
  if (features.footer !== false && await page.locator('body.embedded').count()) {
    const restore = page.locator('#focus-restore-bottom');
    assert.ok(await restore.isVisible(), 'A visitor must be able to restore the footer from focus mode.');
    await restore.press('Enter');
  }
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(resolved => document.documentElement.dataset.theme === resolved, colorScheme);
    if (features.footer !== false) assert.ok(await page.locator('#site-footer [data-i18n="footer.affiliation"]').isVisible());
    await about.click();
    if (features.footer === false) assert.ok(await page.locator('#information-dialog [data-i18n="footer.affiliation"]').isVisible());
    for (const project of ['joomengine/playground', 'joomla/joomla-cms']) {
      const credit = page.locator(`#information-dialog .credits-list a[href="https://github.com/${project}"]`);
      assert.ok(await credit.isVisible(), `${project} credit must be visible in ${colorScheme} mode.`);
    }
    await page.locator('#information-dialog [data-close-dialog]').click();
  }
  assert.deepEqual(errors, []);
});
