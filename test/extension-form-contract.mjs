import assert from 'node:assert/strict';

/** Native validation must reveal fields inside a deployment dialog closed before Launch. */
export async function assertExtensionFormValidation(page) {
  const dialog = page.locator('#deploy-dialog');
  const advanced = page.locator('#extension-advanced');
  const json = page.locator('#extensions');
  const originalJSON = await json.inputValue();
  const originallyOpen = await dialog.isVisible();
  const advancedOriginallyOpen = await advanced.getAttribute('open') !== null;
  if (!originallyOpen) await page.locator('#deploy-editor-button').click();
  if (advancedOriginallyOpen) await advanced.locator('summary').click();

  await page.locator('#package-url').fill('example.org/missing-protocol.zip');
  await dialog.locator('[data-close-dialog]').click();
  await page.locator('#launch-button').click();
  await page.locator('#deploy-dialog[open]').waitFor();
  assert.equal(await page.locator('#package-url').evaluate(input => document.activeElement === input), true,
    'Launch reveals and focuses an invalid URL after the deployment dialog has been closed.');
  assert.equal(await page.locator('#package-url').inputValue(), 'example.org/missing-protocol.zip');
  assert.equal(await json.isVisible(), false, 'Correcting an ordinary URL does not require the JSON editor.');

  await page.locator('#package-url').fill('https://example.org/valid-package.zip');
  await advanced.locator('summary').click();
  const unfinishedJSON = '[{"url":"https://example.org/unfinished-package.zip"';
  await json.fill(unfinishedJSON);
  await dialog.locator('[data-close-dialog]').click();
  await page.locator('#launch-button').click();
  await page.locator('#deploy-dialog[open]').waitFor();
  assert.equal(await json.isVisible(), true, 'Launch reveals the Advanced JSON editor containing an error.');
  assert.equal(await json.evaluate(input => document.activeElement === input), true,
    'Launch focuses the invalid JSON editor so the draft can be corrected.');
  assert.equal(await json.inputValue(), unfinishedJSON, 'Reopening the dialog preserves an unfinished JSON draft.');

  await json.fill(originalJSON);
  if (!advancedOriginallyOpen) await advanced.locator('summary').click();
  if (!originallyOpen) await dialog.locator('[data-close-dialog]').click();
}
