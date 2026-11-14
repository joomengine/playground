import assert from 'node:assert/strict';

/** Hold a real automatic checkpoint while the completed Joomla request stays usable. */
export async function assertResponsiveSave(page) {
  if (!await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
  await page.locator('#save-state').filter({ hasText: /^Saved locally/i }).waitFor();
  const frameURL = await page.locator('#site-frame').getAttribute('src');
  const mutate = () => page.evaluate(async () => {
    const base = document.getElementById('site-frame').src.match(/^(.*\/__site\/[^/]+\/[^/]+\/)/)?.[1];
    if (!base) throw new Error('The running Joomla URL is missing.');
    const response = await fetch(new URL('modules/mod_playground_contract/contract.php?action=seed', base));
    return { status: response.status, body: await response.json() };
  });
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
    const request = await mutate();
    assert.equal(request.status, 200, 'A successful Joomla edit completes before browser persistence.');
    await page.waitForFunction(() => typeof window.__releaseSave === 'function');
    assert.match(await page.locator('#save-state').textContent(), /saving/i);
    for (const id of ['nav-site', 'nav-admin', 'share-button', 'download-dialog-button', 'close-button', 'php-settings-button']) {
      assert.equal(await page.locator(`#${id}`).isEnabled(), true, `${id} must remain responsive during automatic persistence.`);
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
  await page.locator('#save-state').filter({ hasText: /^Saved locally/i }).waitFor();

  // A durable-storage failure cannot turn a completed PHP operation into an
  // HTTP error or destroy its live state. Keep failing until explicitly removed.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    window.__restoreSaveIntercept = () => { Worker.prototype.postMessage = original; };
    Worker.prototype.postMessage = function (message, ...options) {
      if (message?.type === 'operation' && message.operation === 'flush') {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: {
          type: 'result', id: message.id, error: 'Browser storage rejected the write (QuotaExceededError).',
          name: 'QuotaExceededError', fatal: false,
        } })));
        return;
      }
      return original.call(this, message, ...options);
    };
  });
  try {
    assert.equal((await mutate()).status, 200);
    await page.locator('#save-state').filter({ hasText: /not yet saved/i }).waitFor();
    assert.equal(await page.locator('#site-frame').getAttribute('src'), frameURL);
    assert.equal(await page.locator('#save-button').isEnabled(), true, 'Deployment configuration Save remains usable.');
    assert.equal(await page.locator('#download-dialog-button').isEnabled(), true, 'A complete download remains available.');
  } finally {
    await page.evaluate(() => { window.__restoreSaveIntercept?.(); delete window.__restoreSaveIntercept; });
  }
  await mutate();
  await page.locator('#save-state').filter({ hasText: /^Saved locally/i }).waitFor();
}
