import assert from 'node:assert/strict';

/** Hold the actual persistence operation to test the shell during a slow save. */
export async function assertResponsiveSave(page) {
  if (!await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
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
  });
  try {
    await page.locator('#save-button').click();
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

  // The settings stay editable while saving. A storage failure must not roll
  // back a staged Keep choice that belongs to the next launch.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    window.__restoreSaveIntercept = () => { Worker.prototype.postMessage = original; };
    Worker.prototype.postMessage = function (message, ...options) {
      if (message?.type === 'operation' && message.operation === 'flush') {
        Worker.prototype.postMessage = original;
        window.__failSave = () => this.dispatchEvent(new MessageEvent('message', {
          data: { type: 'result', id: message.id, error: 'Simulated background storage failure', fatal: false },
        }));
        return;
      }
      return original.call(this, message, ...options);
    };
    document.getElementById('save-button').click();
  });
  try {
    await page.waitForFunction(() => typeof window.__failSave === 'function');
    await page.locator('label[for="persistence"]').click();
    assert.equal(await page.locator('#persistence').isChecked(), false);
    await page.evaluate(() => window.__failSave());
    await page.locator('#save-button:enabled').waitFor();
    assert.equal(await page.locator('#persistence').isChecked(), false,
      'An asynchronous save failure must preserve the staged Keep setting.');
    assert.match(await page.locator('#header-feedback').textContent(), /Simulated background storage failure/);
  } finally {
    await page.evaluate(() => {
      window.__restoreSaveIntercept?.(); window.__failSave?.();
      delete window.__restoreSaveIntercept; delete window.__failSave;
    });
    if (!await page.locator('#persistence').isChecked()) await page.locator('label[for="persistence"]').click();
  }
  await page.locator('#save-button').click();
  await page.locator('#save-button:enabled').waitFor();
}
