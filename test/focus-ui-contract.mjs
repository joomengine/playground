import assert from 'node:assert/strict';

const bars = ['site-header', 'site-footer'];
const restoreControls = ['focus-restore-top', 'focus-restore-bottom'];

async function assertHiddenControls(page) {
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('embedded')), true);
  for (const id of [...bars, 'settings', 'activity-dock']) {
    assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} must hide with the playground controls.`);
    assert.equal(await page.locator(`#${id}`).evaluate(node => node.getBoundingClientRect().height), 0,
      `${id} must collapse completely, without a remaining strip.`);
  }
  for (const id of restoreControls) {
    const control = page.locator(`#${id}`);
    assert.equal(await control.isVisible(), true);
    const geometry = await control.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return { position: getComputedStyle(button).position, left: rect.left, top: rect.top + scrollY,
        bottom: rect.bottom + scrollY, width: rect.width, height: rect.height,
        documentHeight: document.body.getBoundingClientRect().height };
    });
    assert.equal(geometry.position, 'absolute', `${id} must overlay its document corner without reserving a row.`);
    assert.equal(geometry.left, 0, `${id} must sit entirely in the physical left corner, including RTL.`);
    assert.equal(geometry.width, 20); assert.equal(geometry.height, 20,
      `${id} must have a compact corner hit area rather than cover Joomla controls.`);
    assert.equal(id.endsWith('top') ? geometry.top : geometry.bottom,
      id.endsWith('top') ? 0 : geometry.documentHeight, `${id} must touch its document edge.`);
  }
  const layout = await page.evaluate(() => {
    const content = document.getElementById('site-mount').hidden
      ? document.getElementById('welcome') : document.getElementById('site-mount');
    const main = document.querySelector('main').getBoundingClientRect();
    return { contentTop: content.getBoundingClientRect().top + scrollY, mainTop: main.top + scrollY,
      mainBottom: main.bottom + scrollY, bodyHeight: document.body.getBoundingClientRect().height };
  });
  assert.equal(layout.mainTop, 0, 'Collapsed chrome must reserve no space above the site.');
  assert.equal(layout.contentTop, 0, 'The site starts at the document edge.');
  assert.equal(layout.mainBottom, layout.bodyHeight, 'Collapsed footer and restore controls must reserve no space below the site.');
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
  const theme = page.locator('#theme-toggle');
  const previous = await page.locator('html').getAttribute('data-theme');
  const previousPreference = await page.locator('html').getAttribute('data-theme-preference');
  const settingsVisible = await page.locator('#settings').isVisible();
  const viewport = page.viewportSize();
  const stablePaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const choose = async value => {
    if (await page.locator('html').getAttribute('data-theme') !== value) await theme.click();
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, value);
    assert.equal(await theme.evaluate(button => getComputedStyle(button).colorScheme), value,
      'Native settings controls must use the selected appearance.');
    assert.equal(await theme.getAttribute('data-icon'), `theme-${value}`, 'The toggle icon shows the active appearance.');
    assert.equal(await theme.getAttribute('aria-pressed'), String(value === 'dark'));
    await stablePaint();
  };
  try {
    if (!settingsVisible) await page.locator('#settings-toggle').click();
    assert.equal(await theme.evaluate(button => button.previousElementSibling?.id), 'download-dialog-button',
      'The single appearance icon stays immediately beside Downloads.');
    assert.equal(await page.locator('#theme-preference').count(), 0, 'There is no separate System selector.');
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
    assert.equal(await page.locator('#theme-preference').count(), 0, 'Appearance has one toggle and no System selector.');
    assert.equal(await page.locator('.header-actions #save-button, .header-actions #download-dialog-button').count(), 0,
      'Save and Download belong to the running-site actions.');
    assert.equal(await page.locator('#site-actions #save-button').count(), 1);
    assert.equal(await page.locator('#site-actions #download-dialog-button').count(), 1);
    assert.equal(await page.locator('#upload-site-button').evaluate(button => {
      const buttons = [...button.parentElement.querySelectorAll('button')];
      return buttons[buttons.indexOf(button) + 1]?.id;
    }), 'download-dialog-button', 'Download immediately follows Upload in the site actions.');
    assert.equal(await page.locator('#edit-deployment svg').count(), 1, 'Edit deployment has one decorated icon.');
    assert.doesNotMatch(await page.locator('#edit-deployment').textContent(), /[✎✏]/);
    assert.equal(await page.locator('#configuration-fields').evaluate(fieldset => fieldset.querySelector('legend').nextElementSibling?.id), 'site-actions',
      'Site actions are the first dashboard row, above saved-site details.');
    // Start from a known OS value, then prove a manual toggle only lasts until
    // the OS changes again, even when the first change matches the override.
    await page.emulateMedia({ colorScheme: 'light' });
    await choose('light'); await choose('dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.themePreference === 'system');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await theme.getAttribute('data-icon'), 'theme-light', 'System changes also update the current-mode icon.');
    // A second manual click still works after returning to system alignment.
    await choose('dark'); await choose('light');
    const backgrounds = {};
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const mode of ['light', 'dark']) {
        await choose(mode);
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture?.(`shell-dashboard-${mode}-${width}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          'The expanded dashboard must fit the viewport.');
        const layout = await page.evaluate(() => {
          const actions = document.getElementById('site-actions');
          return { actionsBottom: actions.getBoundingClientRect().bottom,
            savedTop: document.querySelector('.site-switcher').getBoundingClientRect().top,
            rightGap: actions.getBoundingClientRect().right - actions.lastElementChild.getBoundingClientRect().right,
            logoContent: getComputedStyle(document.querySelector('.brand img')).content,
            logoBackground: getComputedStyle(document.querySelector('.brand img')).backgroundColor };
        });
        assert.ok(layout.actionsBottom <= layout.savedTop, 'Site actions appear above saved-site details.');
        assert.ok(Math.abs(layout.rightGap) <= 1, 'Site actions align to the far right of the dashboard.');
        if (mode === 'light') {
          assert.match(layout.logoContent, /joomengine-logo-light\.svg/);
          assert.equal(layout.logoBackground, 'rgba(0, 0, 0, 0)', 'Light wordmark has no dark plate.');
        }
        backgrounds[mode] = await page.locator('#settings').evaluate(node => getComputedStyle(node).backgroundColor);
        // Enter the icon from its preceding header control to verify the
        // visible keyboard focus indicator independently of iframe tab order.
        await theme.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
        const focus = await theme.evaluate(node => {
          const style = getComputedStyle(node);
          return { active: document.activeElement?.id, visible: node.matches(':focus-visible'),
            outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        });
        assert.equal(focus.active, 'theme-toggle', `Keyboard focus returns to the appearance button: ${JSON.stringify(focus)}`);
        assert.ok(focus.visible && focus.outline !== 'none' && focus.width >= 2,
          `The appearance button keeps a visible keyboard focus indicator: ${JSON.stringify(focus)}`);
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
    if (previousPreference === 'system') {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.emulateMedia({ colorScheme: 'light' });
    }
    await page.emulateMedia({ colorScheme: null });
    if (previousPreference !== 'system') await choose(previous);
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
        assert.ok(hideLeft <= 12, 'Hide controls stay beside the left-corner restore tabs, including RTL.');
        if (keyboard) { await hideControl.focus(); await page.keyboard.press('Enter'); }
        else await hideControl.click();
        await assertHiddenControls(page);
        const sameEdge = page.locator(`#focus-restore-${hide === 'focus-header-button' ? 'top' : 'bottom'}`);
        assert.ok(Math.abs(await sameEdge.evaluate(button => button.getBoundingClientRect().left) - hideLeft) <= 12,
          'Hiding chrome must not move its restore affordance to the opposite edge.');
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2 - innerHeight / 2));
        await assertHiddenControls(page);
        for (const id of restoreControls) assert.equal(await page.locator(`#${id}`).evaluate(button => {
          const box = button.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight;
        }), false, 'Restore tabs must leave the viewport in the middle of a long Joomla page.');
        if (hide === 'focus-header-button') await capture?.(`hidden-middle-${width}`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await assertHiddenControls(page);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        const restoreControl = page.locator(`#${restore}`);
        await restoreControl.scrollIntoViewIfNeeded();
        const hitArea = await restoreControl.evaluate(button => {
          const rect = button.getBoundingClientRect(), top = button.id.endsWith('top');
          const inside = document.elementFromPoint(rect.left + 3, rect.top + (top ? 3 : 17));
          const outside = document.elementFromPoint(rect.left + 17, rect.top + (top ? 17 : 3));
          return { inside: inside === button || button.contains(inside),
            outside: outside === button || button.contains(outside) };
        });
        assert.equal(hitArea.inside, true, 'The small corner triangle accepts activation.');
        assert.equal(hitArea.outside, false, 'The clipped area passes through to Joomla instead of covering its controls.');
        if (keyboard) { await restoreControl.focus(); await page.keyboard.press('Enter'); }
        else await restoreControl.click({ position: { x: 3, y: restore.endsWith('top') ? 3 : 17 } });
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
  // Initial controls can render before the service worker's controlled reload.
  // Exercise one confirmed document, while catalog initialization is still free
  // to finish after the explicit restore below.
  await page.locator('html[data-playground-environment="ready"]').waitFor();
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
