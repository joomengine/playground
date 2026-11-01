import assert from 'node:assert/strict';
import { readURLConfiguration } from '../src/config.mjs';
import { assertLaunchReadiness } from './launch-readiness-browser.mjs';

/** Changing launch timing must not change the deployment being shared. */
export async function assertImmediateShareOption(page) {
  const option = page.locator('#share-immediate');
  const normal = await page.locator('#share-url').inputValue();
  assert.equal(await option.isChecked(), false, 'Shared links retain the countdown by default.');
  assert.equal(await option.getAttribute('aria-describedby'), 'share-immediate-help');
  assert.equal(readURLConfiguration(normal).immediate, false);
  await option.check();
  const checked = await page.locator('#share-url').inputValue();
  assert.equal(new URL(checked).searchParams.get('immediate'), '1');
  assert.deepEqual(readURLConfiguration(checked).config, readURLConfiguration(normal).config);
  await option.uncheck();
  assert.equal(await page.locator('#share-url').inputValue(), normal);
}

/** Observe the real launch path without relying on machine-dependent timing. */
export async function assertImmediateLaunch(page, baseURL, waitUntilRunning) {
  await page.addInitScript(() => {
    window.immediateCountdownObserved = false;
    new MutationObserver(() => {
      for (const id of ['launch-countdown', 'dashboard-countdown']) {
        const countdown = document.getElementById(id);
        if (countdown && !countdown.hidden) window.immediateCountdownObserved = true;
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  });
  const url = new URL(baseURL);
  url.searchParams.set('immediate', '1');
  url.searchParams.set('start', '0');
  await page.goto(url.href);
  await page.locator('#embedded-launch:enabled').waitFor();
  assert.equal(await page.locator('#site-frame').count(), 0, 'start=0 still waits for manual launch.');
  assert.equal(await page.locator('#launch-countdown').isVisible(), false);
  assert.equal(await page.locator('#loading-view').isVisible(), false);
  const readiness = await assertLaunchReadiness(page);
  url.searchParams.set('start', '1');
  await page.goto(url.href);
  await waitUntilRunning();
  assert.equal(await page.evaluate(() => window.immediateCountdownObserved), false,
    'Immediate deployment must reach the real running site without showing a countdown.');
  assert.equal(await page.locator('#launch-countdown').isVisible(), false);
  assert.equal(await page.locator('#dashboard-countdown').isVisible(), false);
  return { immediate: true, startZeroPreserved: true, countdownSkipped: true, readiness };
}
