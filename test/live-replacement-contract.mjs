import assert from 'node:assert/strict';

/** Choose the explicit destructive path after the user-facing preservation options appear. */
export async function continueLiveReplacement(page) {
  const dialog = page.locator('dialog[data-live-replacement]');
  await dialog.waitFor({ state: 'visible' });
  for (const choice of ['cancel', 'backup', 'download', 'continue']) {
    assert.equal(await dialog.locator(`[data-replace-choice="${choice}"]`).count(), 1,
      `Replacing a live site must offer ${choice}.`);
  }
  await dialog.locator('[data-replace-choice="continue"]').click();
  await dialog.waitFor({ state: 'detached' });
}
