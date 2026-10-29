import assert from 'node:assert/strict';
import { probeSyntheticRedirect, startRedirectTrace, recordVerifiedRedirectDiagnostic } from './firefox-redirect-probe.mjs';

/** Save real Joomla administration forms with maximum diagnostics and keep using the site. */
export async function assertJoomlaDebugConfiguration(page, { redirectProbe } = {}) {
  const probe = redirectProbe ?? await probeSyntheticRedirect(page.context().browser());
  const frame = await (await page.locator('#site-frame').elementHandle()).contentFrame();
  const initial = frame.url();
  const match = initial.match(/^(.*\/__site\/[^/]+\/[^/]+\/)/);
  assert.ok(match, 'The running site must have its private routed URL.');
  const base = match[1];
  const configurationURL = new URL('administrator/index.php?option=com_config', base).href;
  const settleFonts = () => frame.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;
  });
  const save = async () => {
    await settleFonts();
    const from = page.consoleErrors?.length ?? 0;
    const traceFrom = await startRedirectTrace(page);
    const [response] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'load', timeout: 90_000 }),
      frame.locator('joomla-toolbar-button[task="application.apply"] button').click(),
    ]);
    assert.equal(response.status(), 200);
    assert.match(await frame.locator('body').innerText(), /Configuration saved/i);
    await settleFonts();
    if (page.consoleErrors) await recordVerifiedRedirectDiagnostic(page, {
      probe, kind: 'post303', from, traceFrom,
      sourceURL: new URL('service-worker.mjs', page.url()).href, step: page.testStep,
      finalURL: frame.url(), responseStatus: response.status(), methodAfterRedirect: response.request().method(),
    });
  };
  page.testStep = 'maximum Joomla error reporting saves through its administration form';
  await settleFonts();
  await frame.goto(configurationURL, { waitUntil: 'load' });
  await frame.getByRole('tab', { name: 'Server', exact: true }).click();
  await frame.locator('#jform_error_reporting').selectOption('maximum');
  await save();
  page.testStep = 'Joomla Debug System saves and remains usable';
  await frame.getByRole('tab', { name: 'System', exact: true }).click();
  await frame.locator('#jform_debug1').check();
  await save();
  assert.equal(await frame.locator('#jform_debug1').isChecked(), true);
  assert.equal(await frame.locator('#jform_error_reporting').inputValue(), 'maximum');
  page.testStep = 'frontend and administrator survive enabled Joomla diagnostics';
  const frontend = await frame.goto(base, { waitUntil: 'load' });
  assert.equal(frontend.status(), 200);
  assert.doesNotMatch(await frame.locator('body').innerText(), /SQLSTATE|Fatal error|already leased/);
  await settleFonts();
  const reopened = await frame.goto(configurationURL, { waitUntil: 'load' });
  assert.equal(reopened.status(), 200);
  assert.equal(await frame.locator('#jform_debug1').isChecked(), true);
  assert.equal(await frame.locator('#jform_error_reporting').inputValue(), 'maximum');
  page.testStep = 'restore Joomla diagnostic settings through its administration form';
  await frame.getByRole('tab', { name: 'System', exact: true }).click();
  await frame.locator('#jform_debug0').check();
  await frame.getByRole('tab', { name: 'Server', exact: true }).click();
  await frame.locator('#jform_error_reporting').selectOption('default');
  await save();
  await frame.goto(initial, { waitUntil: 'load' });
  return { maximumErrorReporting: true, debugSystem: true, frontend: true, administrator: true };
}
