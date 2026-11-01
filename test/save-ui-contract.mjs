import assert from 'node:assert/strict';

/** Hold the actual persistence operation to test the shell during a slow save. */
export async function assertResponsiveSave(page) {
  await page.locator('#save-button:enabled').waitFor();
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    window.__restoreSaveIntercept = () => { Worker.prototype.postMessage = original; };
    window.__saveFrames = 0;
    Worker.prototype.postMessage = function (message, ...options) {
      if (message?.type === 'operation' && message.operation === 'flush') {
        Worker.prototype.postMessage = original;
        window.__releaseSave = () => original.call(this, message, ...options);
        return;
      }
      return original.call(this, message, ...options);
    };
    document.getElementById('save-button').click();
  });
  try {
    await page.waitForFunction(() => typeof window.__releaseSave === 'function');
    assert.equal(await page.locator('#save-button').isDisabled(), true);
    assert.match(await page.locator('#save-state').textContent(), /saving/i);
    for (const id of ['nav-site', 'nav-admin', 'share-button', 'download-dialog-button', 'close-button', 'php-settings-button']) {
      assert.equal(await page.locator(`#${id}`).isEnabled(), true, `${id} must remain responsive during persistence.`);
    }
    await page.locator('#share-button').click();
    await page.locator('#share-dialog').waitFor({ state: 'visible' });
    await page.locator('#share-dialog [data-close-dialog]').click();
    await page.evaluate(() => new Promise(resolve => {
      const next = () => { if (++window.__saveFrames === 3) resolve(); else requestAnimationFrame(next); };
      requestAnimationFrame(next);
    }));
    assert.equal(await page.evaluate(() => window.__saveFrames), 3);
  } finally {
    await page.evaluate(() => {
      window.__restoreSaveIntercept?.(); window.__releaseSave?.();
      delete window.__restoreSaveIntercept; delete window.__releaseSave;
    });
  }
  await page.locator('#save-button:enabled').waitFor();
}
