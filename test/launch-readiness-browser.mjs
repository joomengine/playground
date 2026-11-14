import assert from 'node:assert/strict';

/** Changing setup previews the real launch path without preparing an image. */
export async function assertLaunchReadiness(page) {
  const requests = [];
  const observe = request => requests.push(request.url());
  page.on('request', observe);
  const state = value => page.locator(`#launch-readiness[data-readiness="${value}"]`).waitFor({ state: 'attached' });
  try {
    if (!await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
    await state('fast');
    assert.equal(await page.locator('#launch-readiness').getAttribute('aria-live'), 'polite');
    const php = page.locator('#php-version');
    const originalPHP = await php.inputValue();
    const alternative = await php.locator('option:not(:disabled)').evaluateAll((options, current) => options.find(option => option.value !== current)?.value, originalPHP);
    assert.ok(alternative, 'The built manifest must offer another compatible PHP runtime.');
    await php.selectOption(alternative);
    await state('fast');
    await php.selectOption(originalPHP);
    await state('fast');
    await page.locator('#edit-deployment').click();
    const name = page.locator('#site-name');
    const originalName = await name.inputValue();
    // Readiness refreshes when configuration is finished, without inspecting
    // or validating every unfinished edit inside the open popup.
    await name.fill(`${originalName} edited`);
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    await state('fresh');
    await page.locator('#edit-deployment').click();
    await name.fill(originalName);
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    await state('fast');
    await page.locator('#edit-deployment').click();
    const initialPath = page.locator('#initial-path');
    const originalPath = await initialPath.inputValue();
    await initialPath.fill('https://outside.example/');
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    await state('checking');
    await page.locator('#edit-deployment').click();
    await initialPath.fill(originalPath);
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    await state('fast');
    assert.equal(await page.locator('#site-frame').count(), 0);
    assert.equal(requests.some(url => /\.(?:zip|wasm|so)(?:\?|$)/.test(url)), false,
      'Previewing readiness must not download archives or start a runtime.');
    return { prepared: true, compatiblePHP: true, changedRecipe: true, reverted: true, noArchiveDownloads: true };
  } finally { page.off('request', observe); }
}
