import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';
import { assertLaunchMediaMetadata } from './launch-ui-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Exercise the shipped markup and video without downloading/installing Joomla.
// The full runtime suite separately verifies playback through the Launch action.
const fixture = (await readFile(new URL('../index.html', import.meta.url), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const engines = { chromium, firefox };
const selected = process.env.PLAYGROUND_BROWSERS?.split(',').map(value => value.trim()).filter(Boolean)
  ?? Object.keys(engines);
for (const name of selected) {
  assert.ok(engines[name], `Unsupported browser: ${name}`);
  test(`${name}: shipped launch media declares inline playback and plays the real video`, { timeout: 60_000 }, async () => {
    const server = await createStaticServer({ directory: root, fixtures: { 'launch-media.html': fixture } });
    let browser;
    try {
      browser = await engines[name].launch({ headless: true });
      const page = await browser.newPage({ reducedMotion: 'no-preference' });
      await page.goto(`${server.url}launch-media.html`);
      await assertLaunchMediaMetadata(page);
      // The compatibility fix still rejects missing inline-playback markup.
      await page.locator('#launch-video').evaluate(video => video.removeAttribute('playsinline'));
      await assert.rejects(assertLaunchMediaMetadata(page), { name: 'AssertionError' });
      await page.locator('#launch-video').evaluate(video => video.setAttribute('playsinline', ''));
      await page.evaluate(async () => {
        document.getElementById('welcome').hidden = true;
        document.getElementById('loading-view').hidden = false;
        await document.getElementById('launch-video').play();
      });
      await page.waitForFunction(() => {
        const video = document.getElementById('launch-video');
        return !video.paused && video.currentTime > 0;
      }, undefined, { timeout: 15_000 });
      await page.locator('#launch-video').evaluate(video => video.pause());
      await assertLaunchMediaMetadata(page);
    } finally {
      await browser?.close();
      await server.close();
    }
  });
}
