import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Simulate a publication while the actual site is open, then reopen its saved SQL/files. */
export async function assertBuildUpdate(page, { fixtures, indexHTML, readSite }) {
  const loadedId = await page.locator('meta[name="joomengine-build"]').getAttribute('content');
  assert.match(loadedId, /^[a-f0-9]{64}$/, 'Published HTML includes the exact build identity.');
  const nextId = createHash('sha256').update(`${loadedId}:next-publication`).digest('hex');
  const before = await readSite();
  const frameURL = await page.locator('#site-frame').getAttribute('src');
  try {
    fixtures['build.json'] = JSON.stringify({ schemaVersion: 1, id: nextId });
    if (!await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
    await page.locator('#launch-button').click();
    await page.locator('#build-update').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#reload-build').isDisabled(), true);
    assert.match(await page.locator('#build-update-message').innerText(), /Close your running site/);
    // Even a synthetic click cannot bypass the active-site guard.
    await page.locator('#reload-build').dispatchEvent('click');
    assert.equal(await page.locator('#site-frame').getAttribute('src'), frameURL);
    assert.deepEqual(await readSite(), before, 'Detecting a new build keeps the live files and database intact.');
    await page.locator('#save-button').click();
    await page.locator('#save-button:enabled').waitFor({ timeout: 240_000 });
    await page.locator('#close-button').click();
    await page.locator('#reload-build:enabled').waitFor({ timeout: 240_000 });
    const preferences = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));

    const updatedHTML = indexHTML.replace(/(<meta name="joomengine-build" content=")[a-f0-9]{64}(">)/,
      (_, prefix, suffix) => `${prefix}${nextId}${suffix}`);
    fixtures[''] = fixtures['index.html'] = updatedHTML;
    await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('#reload-build').click()]);
    await page.locator('#embedded-launch:enabled').waitFor();
    assert.equal(await page.locator('#build-update').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))), preferences,
      'Updating application assets does not delete saved-site metadata or preferences.');
    await page.locator('#embedded-launch').click();
    assert.deepEqual(await readSite(), before, 'The site reopens with its saved files and database after the update.');
    return { liveSitePreserved: true, reloadRequiresClose: true, savedSiteReopened: true };
  } finally {
    delete fixtures['build.json'];
    delete fixtures[''];
    delete fixtures['index.html'];
  }
}
