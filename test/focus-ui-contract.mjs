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
    assert.equal(await control.evaluate(button => ['fixed', 'sticky'].includes(getComputedStyle(button).position)), false, `${id} must scroll with the document.`);
  }
}

async function assertVisibleControls(page) {
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('embedded')), false);
  for (const id of bars) assert.equal(await page.locator(`#${id}`).isVisible(), true);
  for (const id of restoreControls) assert.equal(await page.locator(`#${id}`).isVisible(), false);
}

/** Capture actual shell controls around the running Joomla document.
 * Viewport resizing is responsive-layout evidence, not native browser zoom.
 */
async function assertShellAppearance(page, capture) {
  const theme = page.locator('#theme-preference');
  const previous = await theme.inputValue();
  const settingsVisible = await page.locator('#settings').isVisible();
  const viewport = page.viewportSize();
  const stablePaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const choose = async value => {
    await theme.selectOption(value);
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, value);
    assert.equal(await theme.evaluate(select => getComputedStyle(select).colorScheme), value,
      'Native settings controls must use the selected appearance.');
    await stablePaint();
  };
  try {
    if (!settingsVisible) await page.locator('#settings-toggle').click();
    const brand = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=icon]');
      const favicon = new Image(); favicon.src = link.href; await favicon.decode();
      const controls = [];
      for (const id of ['deploy-editor-button', 'launch-button']) {
        const icon = document.querySelector(`#${id} img.je-brand-icon`);
        await icon.decode();
        const bounds = icon.getBoundingClientRect(), style = getComputedStyle(icon);
        controls.push({ id, source: new URL(icon.src).pathname, width: bounds.width,
          height: bounds.height, naturalWidth: icon.naturalWidth, objectFit: style.objectFit, filter: style.filter });
      }
      return { href: link.href, sizes: link.sizes.value, type: link.type,
        favicon: { width: favicon.naturalWidth, height: favicon.naturalHeight }, controls };
    });
    assert.match(new URL(brand.href).pathname, /\/src\/brand\/favicon\.svg$/);
    assert.ok(new URL(brand.href).searchParams.get('v'), 'The browser icon uses a versioned asset URL.');
    assert.equal(brand.sizes, 'any'); assert.equal(brand.type, 'image/svg+xml');
    assert.deepEqual(brand.favicon, { width: 32, height: 32 });
    for (const icon of brand.controls) {
      assert.match(icon.source, /\/src\/brand\/rocket\.svg$/);
      assert.equal(icon.naturalWidth, 24); assert.equal(icon.width, 24); assert.equal(icon.height, 24);
      assert.equal(icon.objectFit, 'contain'); assert.equal(icon.filter, 'none', 'Pearl artwork stays full color.');
    }
    // Exercise the actual selector and live OS preference listener.
    await theme.selectOption('system');
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, colorScheme);
    }
    await choose('dark'); await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', 'Explicit appearance overrides System.');
    const backgrounds = {};
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const mode of ['light', 'dark']) {
        await choose(mode);
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture?.(`shell-dashboard-${mode}-${width}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          'The expanded dashboard must fit the viewport.');
        backgrounds[mode] = await page.locator('#settings').evaluate(node => getComputedStyle(node).backgroundColor);
        await theme.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        assert.equal(await theme.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true,
          'The theme selector keeps a visible keyboard focus indicator.');
        await capture?.(`shell-theme-control-${mode}-${width}`);
        await page.locator('#site-footer').scrollIntoViewIfNeeded();
        await capture?.(`shell-footer-${mode}-${width}`);
        await page.locator('#information-button').click();
        await page.locator('#information-dialog[open]').waitFor();
        assert.equal(await page.locator('#information-dialog').evaluate(node => getComputedStyle(node).colorScheme), mode);
        await capture?.(`shell-about-${mode}-${width}`);
        await page.keyboard.press('Escape');
        await page.locator('#information-dialog').waitFor({ state: 'hidden' });
        if (width === 390) {
          await page.locator('#deploy-editor-button').click();
          await page.locator('#deploy-dialog[open]').waitFor();
          assert.equal(await page.locator('#admin-password').evaluate(node => getComputedStyle(node).colorScheme), mode);
          await capture?.(`shell-deployment-${mode}-${width}`);
          await page.keyboard.press('Escape');
          await page.locator('#deploy-dialog').waitFor({ state: 'hidden' });
        }
      }
    }
    assert.notEqual(backgrounds.light, backgrounds.dark, 'Shell panels visibly change with the selected appearance.');
  } finally {
    for (const selector of ['#information-dialog[open]', '#deploy-dialog[open]']) {
      if (await page.locator(selector).count()) await page.keyboard.press('Escape');
    }
    await theme.selectOption(previous);
    await page.emulateMedia({ colorScheme: null });
    if (await page.locator('#settings').isVisible() !== settingsVisible) await page.locator('#settings-toggle').click();
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
}

/** Hide either bar and restore either edge without navigating or replacing Joomla. */
export async function assertLiveFocusMode(page, frame, { capture } = {}) {
  const viewport = page.viewportSize();
  const originalURL = frame.url();
  const originalSource = await page.locator('#site-frame').getAttribute('src');
  const originalDirection = await page.locator('html').getAttribute('dir');
  const originalReducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
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
    await assertShellAppearance(page, capture);
    for (const width of [1440, 390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 768) {
        await page.locator('html').evaluate(html => { html.dir = 'rtl'; });
        await page.emulateMedia({ reducedMotion: 'reduce' });
      }
      for (const [hide, restore, keyboard] of [
        ['focus-header-button', 'focus-restore-bottom', true],
        ['focus-footer-button', 'focus-restore-top', false],
      ]) {
        const hideControl = page.locator(`#${hide}`);
        await hideControl.scrollIntoViewIfNeeded();
        const hideLeft = await hideControl.evaluate(button => button.getBoundingClientRect().left);
        assert.ok(hideLeft <= 12, 'Hide controls stay beside the left-boundary restore tabs, including RTL.');
        if (keyboard) { await hideControl.focus(); await page.keyboard.press('Enter'); }
        else await hideControl.click();
        await assertHiddenControls(page);
        const sameEdge = page.locator(`#focus-restore-${hide === 'focus-header-button' ? 'top' : 'bottom'}`);
        assert.ok(Math.abs(await sameEdge.evaluate(button => button.getBoundingClientRect().left) - hideLeft) <= 2,
          'Hiding chrome must not move its restore affordance to the opposite edge.');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2 - innerHeight / 2));
        for (const id of restoreControls) assert.equal(await page.locator(`#${id}`).evaluate(button => {
          const box = button.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight;
        }), false, 'Restore tabs must leave the viewport in the middle of a long Joomla page.');
        if (hide === 'focus-header-button') await capture?.(`hidden-middle-${width}`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await assertHiddenControls(page);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const restoreControl = page.locator(`#${restore}`);
        await restoreControl.scrollIntoViewIfNeeded();
        if (keyboard) { await restoreControl.focus(); await page.keyboard.press('Enter'); }
        else await restoreControl.click();
        await assertVisibleControls(page);
        await page.waitForFunction(edge => { const area = document.getElementById(edge === 'focus-restore-bottom' ? 'site-footer' : 'site-header').getBoundingClientRect(); return edge === 'focus-restore-bottom' ? area.bottom <= innerHeight + 2 : Math.abs(area.top) <= 2; }, restore);
        assert.equal(await page.evaluate(() => document.activeElement?.id), restore === 'focus-restore-bottom' ? 'focus-footer-button' : 'focus-header-button',
          'Restoration focuses the revealed control without moving focus back into Joomla.');
        assert.equal(await page.evaluate(() => document.getElementById('site-frame') === window.__focusFrameProof), true,
          'Showing or hiding controls must keep the same iframe element.');
        assert.equal(await frame.evaluate(() => document === window.__focusDocumentProof), true,
          'Showing or hiding controls must not reload the Joomla document.');
        assert.equal(frame.url(), originalURL, 'The current Joomla page must not change.');
        assert.equal(await page.locator('#site-frame').getAttribute('src'), originalSource);
        assert.equal(await frame.locator('#rocket-unsaved-focus-proof').inputValue(), 'Unsaved Joomla form value');
        await capture?.(`${restore === 'focus-restore-bottom' ? 'bottom' : 'top'}-restored-${width}`);
      }
    }
    assert.deepEqual(workers, [], 'Hiding controls must not start replacement PHP or database workers.');
    assert.equal(await page.locator('#open-link').count(), 0, 'The ownership-transfer action must be removed.');
  } finally {
    page.off('worker', observeWorker);
    await frame.evaluate(() => { document.getElementById('rocket-unsaved-focus-proof')?.remove(); delete window.__focusDocumentProof; });
    await page.evaluate(() => { delete window.__focusFrameProof; window.scrollTo(0, 0); });
    await page.locator('html').evaluate((html, direction) => { if (direction === null) html.removeAttribute('dir'); else html.dir = direction; }, originalDirection);
    await page.emulateMedia({ reducedMotion: originalReducedMotion ? 'reduce' : 'no-preference' });
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
