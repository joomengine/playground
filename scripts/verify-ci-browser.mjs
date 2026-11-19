import * as playwright from 'playwright';
import { readFile } from 'node:fs/promises';
const browser = await playwright[process.env.PLAYGROUND_BROWSER].launch({ timeout: 15000 });
try {
  const page = await browser.newPage();
  await page.setContent('<p>Playground</p>');
  await page.screenshot({ timeout: 10000 });
  // The Chromium and Firefox rocket suites require a decoded H.264 frame.
  // A text screenshot succeeds on Firefox even if libavcodec is missing.
  if (process.env.PLAYGROUND_BROWSER !== 'webkit') {
    const clip = await readFile('src/brand/rocket-launch.mp4');
    await page.evaluate(src => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = src;
      document.body.append(video);
    }, 'data:video/mp4;base64,' + clip.toString('base64'));
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      if (video.error) throw new Error('Launch video decode failed: ' + video.error.message);
      return video.readyState >= 2 && video.videoWidth > 0;
    }, undefined, { timeout: 15000 });
  }
} finally {
  await browser.close();
}
