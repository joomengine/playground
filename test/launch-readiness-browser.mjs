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
    // Editing a full recipe follows the materialized resolver; reverting its
    // fields restores the original prepared recipe without launching anything.
    await name.fill(`${originalName} edited`);
    await state('fresh');
    await name.fill(originalName);
    await state('fast');
    const initialPath = page.locator('#initial-path');
    const originalPath = await initialPath.inputValue();
    await initialPath.fill('https://outside.example/');
    await state('checking');
    await initialPath.fill(originalPath);
    await state('fast');
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    assert.equal(await page.locator('#site-frame').count(), 0);
    assert.equal(requests.some(url => /\.(?:zip|wasm|so)(?:\?|$)/.test(url)), false,
      'Previewing readiness must not download archives or start a runtime.');
    return { prepared: true, compatiblePHP: true, changedRecipe: true, reverted: true, noArchiveDownloads: true };
  } finally { page.off('request', observe); }
}
