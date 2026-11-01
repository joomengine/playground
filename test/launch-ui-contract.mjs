import assert from 'node:assert/strict';

/** Pause the visible launch before any runtime download, then start explicitly. */
export async function assertLaunchCountdown(page, url) {
  const requests = [];
  const observe = request => requests.push(request.url());
  page.on('request', observe);
  try {
    await page.goto(url);
    await page.locator('#launch-countdown:not([hidden])').waitFor();
    const seconds = Number(await page.locator('#countdown-value').textContent());
    assert.ok(seconds > 0 && seconds <= 10, 'The visitor must have a visible ten-second launch window.');
    assert.equal(await page.locator('#deploy').inputValue(), 'jcb');
    assert.equal(await page.locator('#php-version').inputValue(), '8.4');
    for (const id of ['stop-countdown', 'stop-countdown-button']) {
      assert.equal(await page.locator(`#${id}`).getAttribute('aria-label'), 'Stop countdown');
      assert.equal(await page.locator(`#${id}`).evaluate(button => button.classList.contains('je-icon-only')), true);
      assert.equal(await page.locator(`#${id} .je-icon`).count(), 1);
    }
    await page.locator('#stop-countdown').click();
    assert.equal(await page.locator('#launch-countdown').isVisible(), false);
    await page.locator('#settings-toggle').click();
    assert.equal(await page.locator('#settings #dashboard-countdown').isVisible(), true);
    assert.equal(await page.locator('#stop-countdown-button').isDisabled(), true);
    assert.match(await page.locator('#dashboard-countdown-message').textContent(), /paused/i);
    assert.equal(await page.locator('#dashboard-countdown-value').textContent(), await page.locator('#countdown-value').textContent());
    await page.locator('#settings-toggle').click();
    await page.locator('#welcome-configure').click();
    assert.equal(await page.locator('#deploy-dialog').evaluate(dialog => dialog.open), true);
    // Cross the real countdown deadline: opening configuration must cancel it.
    await page.waitForTimeout(10_500);
    assert.equal(await page.locator('#site-frame').count(), 0);
    assert.equal(await page.locator('#loading-view').isVisible(), false);
    assert.equal(requests.some(request => /\.(?:wasm|so)(?:\?|$)/.test(request)), false,
      'Pausing launch must prevent PHP and MariaDB startup, not merely hide its progress.');
    await page.locator('#deploy-dialog [data-close-dialog]').click();
    const startedAt = Date.now();
    await page.locator('#embedded-launch').click();
    return startedAt;
  } finally { page.off('request', observe); }
}

/** A required setup command failure still supports independent recovery and reset. */
export async function assertFailedDeploymentRecovery(page, url) {
  const location = new URL(url);
  location.searchParams.set('deploy', 'blank');
  location.searchParams.set('key', 'launch-recovery-contract');
  location.searchParams.set('persist', '1');
  location.searchParams.set('commands', JSON.stringify([['joomengine:missing-recovery-command']]));
  location.searchParams.set('start', '0');
  await page.goto(location.href);
  await page.locator('#embedded-launch:enabled').waitFor();
  assert.equal(await page.locator('#deploy-dialog').evaluate(dialog => dialog.open), false);
  await page.locator('#embedded-launch').click();
  await page.locator('#error-view:not([hidden])').waitFor({ timeout: 120_000 });
  const failure = await page.locator('#error-message').innerText();
  assert.ok(failure.trim(), 'The failed required command must retain its error.');
  assert.doesNotMatch(failure, /<!DOCTYPE|<html|<style|__JOOMENGINE_RESULT__/i);
  assert.equal(await page.locator('#header-feedback').isVisible(), false, 'The error summary must not be repeated in a persistent banner.');
  assert.equal(await page.locator('#error-technical-details').isVisible(), true);
  assert.equal(await page.locator('#error-technical-details').getAttribute('open'), null, 'Diagnostics are collapsed initially.');
  assert.match(await page.locator('#error-diagnostics').textContent(), /joomengine|command/i);

  await page.locator('#recover-button').click();
  await page.locator('#repair-button:not([hidden]):enabled').waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('#error-title').innerText(), 'Your saved site is open for recovery');
  assert.equal(await page.locator('#download-dialog-button').isEnabled(), true);
  assert.equal(await page.locator('#open-link').count(), 0);
  await page.locator('#repair-button').click();
  await page.waitForFunction(() => document.getElementById('error-message').textContent.includes('original configuration was backed up'));

  if (!(await page.locator('#settings').isVisible())) await page.locator('#settings-toggle').click();
  const resetDialog = page.waitForEvent('dialog');
  const resetClick = page.locator('#reset-button').click();
  await (await resetDialog).accept();
  await resetClick;
  await page.locator('#welcome:not([hidden])').waitFor({ timeout: 60_000 });
  assert.equal(await page.locator('#header-feedback').isVisible(), false,
    'A successful reset must remove the previous failure banner.');
  assert.equal(await page.locator('#header-feedback').innerText(), '');
  assert.equal(await page.locator('#embedded-launch').isEnabled(), true);
  return { noCustomApprovalPrompt: true, failedInstallationRecovered: true, resetClearsError: true };
}
