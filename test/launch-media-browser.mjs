import assert from 'node:assert/strict';
import { withPinnedCatalog } from './dynamic-catalog-fixture.mjs';

/** The rocket must move while launch is still waiting on its first network check. */
export async function assertLaunchMedia(browser, baseURL) {
  const results = [];
  for (const trigger of ['countdown', 'embedded', 'form']) {
    const context = await withPinnedCatalog(browser, { reducedMotion: 'no-preference' });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    let armed = false, release;
    let markRequested;
    const requested = new Promise(resolve => { markRequested = resolve; });
    await page.route('**/build.json', async route => {
      if (!armed) { await route.continue(); return; }
      armed = false;
      await new Promise(resolve => { release = resolve; markRequested(); });
      const loaded = await page.locator('meta[name="joomengine-build"]').getAttribute('content');
      const changed = `${loaded[0] === 'a' ? 'b' : 'a'}${loaded.slice(1)}`;
      await route.fulfill({ json: { schemaVersion: 1, id: changed } });
    });
    try {
      const url = new URL(baseURL);
      url.searchParams.set('deploy', 'blank');
      url.searchParams.set('persist', '0');
      url.searchParams.set('start', trigger === 'countdown' ? '1' : '0');
      await page.goto(url.href);
      await page.locator('#embedded-launch:enabled').waitFor();
      assert.equal(await page.locator('#launch-video').evaluate(video => video.paused), true);
      assert.equal(await page.locator('#loading-view').isVisible(), false);
      if (trigger === 'countdown') await page.locator('#launch-countdown:not([hidden])').waitFor();
      // Manual launches can wait for decoding before holding a request whose
      // production timeout is five seconds. Arm the countdown immediately so
      // slow decoding cannot let its launch slip past the intercepted check.
      if (trigger !== 'countdown') {
        await page.waitForFunction(() => document.getElementById('launch-video').readyState >= 2);
      }
      if (trigger === 'form') await page.locator('#settings-toggle').click();
      armed = true;
      if (trigger !== 'countdown') await page.locator(trigger === 'form' ? '#launch-button' : '#embedded-launch').click();
      let deadline;
      try {
        await Promise.race([requested, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`${trigger}: launch did not reach its update check.`)), 15_000);
        })]);
      } finally { clearTimeout(deadline); }
      await page.waitForFunction(() => {
        const video = document.getElementById('launch-video');
        return !document.getElementById('loading-view').hidden && !video.hidden && !video.paused && video.currentTime > 0;
      }, undefined, { timeout: 3_000 });
      assert.equal(await page.locator('#site-frame').count(), 0,
        `${trigger}: playback must begin before a site exists.`);
      release();
      await page.locator('#build-update').waitFor({ state: 'visible' });
      await page.locator('#embedded-launch:enabled').waitFor();
      assert.equal(await page.locator('#welcome').isVisible(), true,
        `${trigger}: blocked preflight must return to the landing page.`);
      assert.equal(await page.locator('#launch-video').evaluate(video => video.paused && video.hidden), true);
      assert.equal(await page.locator('#launch-image-poster').evaluate(poster => poster.hidden), false);
      results.push(trigger);
    } finally {
      release?.();
      await context.close();
    }
  }
  return { playingBeforePreflight: results, abortedLaunchRestoresPoster: true };
}
