import assert from 'node:assert/strict';

const bars = ['site-header', 'site-footer'];
const restoreControls = ['focus-restore-top', 'focus-restore-bottom'];

async function assertHiddenControls(page) {
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('embedded')), true);
  for (const id of [...bars, 'settings', 'activity-dock']) {
    assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} must hide with the playground controls.`);
  }
  for (const id of restoreControls) {
    const control = page.locator(`#${id}`);
    assert.equal(await control.isVisible(), true);
    assert.equal(await control.evaluate(button => {
      const bounds = button.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= innerHeight + 1 && bounds.left >= 0 && bounds.right <= innerWidth + 1;
    }), true, `${id} must remain available inside the viewport.`);
  }
}

async function assertVisibleControls(page) {
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('embedded')), false);
  for (const id of bars) assert.equal(await page.locator(`#${id}`).isVisible(), true);
  for (const id of restoreControls) assert.equal(await page.locator(`#${id}`).isVisible(), false);
}

/** Hide either bar and restore either edge without navigating or replacing Joomla. */
export async function assertLiveFocusMode(page, frame) {
  const viewport = page.viewportSize();
  const originalURL = frame.url();
  const originalSource = await page.locator('#site-frame').getAttribute('src');
  const workers = [];
  const observeWorker = worker => workers.push(worker.url());
  page.on('worker', observeWorker);
  await page.evaluate(() => { window.__focusFrameProof = document.getElementById('site-frame'); });
  await frame.evaluate(() => {
    window.__focusDocumentProof = document;
    const input = document.createElement('input');
    input.id = 'rocket-unsaved-focus-proof'; input.value = 'Unsaved Joomla form value';
    document.body.append(input);
  });
  try {
    for (const width of [1440, 390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [hide, restore, keyboard] of [
        ['focus-header-button', 'focus-restore-bottom', true],
        ['focus-footer-button', 'focus-restore-top', false],
      ]) {
        const hideControl = page.locator(`#${hide}`);
        await hideControl.scrollIntoViewIfNeeded();
        if (keyboard) { await hideControl.focus(); await page.keyboard.press('Enter'); }
        else await hideControl.click();
        await assertHiddenControls(page);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await assertHiddenControls(page);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const restoreControl = page.locator(`#${restore}`);
        if (keyboard) { await restoreControl.focus(); await page.keyboard.press('Enter'); }
        else await restoreControl.click();
        await assertVisibleControls(page);
        assert.equal(await page.evaluate(() => document.getElementById('site-frame') === window.__focusFrameProof), true,
          'Showing or hiding controls must keep the same iframe element.');
        assert.equal(await frame.evaluate(() => document === window.__focusDocumentProof), true,
          'Showing or hiding controls must not reload the Joomla document.');
        assert.equal(frame.url(), originalURL, 'The current Joomla page must not change.');
        assert.equal(await page.locator('#site-frame').getAttribute('src'), originalSource);
        assert.equal(await frame.locator('#rocket-unsaved-focus-proof').inputValue(), 'Unsaved Joomla form value');
      }
    }
    assert.deepEqual(workers, [], 'Hiding controls must not start replacement PHP or database workers.');
    assert.equal(await page.locator('#open-link').count(), 0, 'The ownership-transfer action must be removed.');
  } finally {
    page.off('worker', observeWorker);
    await frame.evaluate(() => { document.getElementById('rocket-unsaved-focus-proof')?.remove(); delete window.__focusDocumentProof; });
    await page.evaluate(() => { delete window.__focusFrameProof; window.scrollTo(0, 0); });
    await page.setViewportSize(viewport);
  }
  return { sameIframe: true, sameDocument: true, unsavedForm: true, noReplacementWorkers: true, keyboard: true, responsive: true };
}

/** The existing toolbar=0 URL enters the same reversible focus mode. */
export async function assertInitialFocusMode(page, url) {
  const target = new URL(url);
  target.searchParams.set('toolbar', '0');
  target.searchParams.set('start', '0');
  await page.goto(target.href);
  await page.locator('#focus-restore-top').waitFor({ state: 'visible' });
  await assertHiddenControls(page);
  await page.locator('#focus-restore-top').focus();
  await page.keyboard.press('Enter');
  await assertVisibleControls(page);
  // Finishing asynchronous catalog loading must not undo the explicit restore.
  await page.locator('#embedded-launch:enabled').waitFor({ state: 'visible' });
  await assertVisibleControls(page);
  assert.equal(await page.locator('#site-frame').count(), 0, 'Restoring controls must not launch or restart Joomla.');
  return { initialToolbarHidden: true, keyboardRestore: true };
}
