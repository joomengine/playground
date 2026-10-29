import assert from 'node:assert/strict';

/** Save real Joomla administration forms with maximum diagnostics and keep using the site. */
export async function assertJoomlaDebugConfiguration(page) {
  const frame = await (await page.locator('#site-frame').elementHandle()).contentFrame();
  const initial = frame.url();
  const match = initial.match(/^(.*\/__site\/[^/]+\/[^/]+\/)/);
  assert.ok(match, 'The running site must have its private routed URL.');
  const base = match[1];
  const configurationURL = new URL('administrator/index.php?option=com_config', base).href;
  const save = async () => {
    const [response] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'load', timeout: 90_000 }),
      frame.locator('joomla-toolbar-button[task="application.apply"] button').click(),
    ]);
    assert.equal(response.status(), 200);
    assert.match(await frame.locator('body').innerText(), /Configuration saved/i);
  };
  page.testStep = 'maximum Joomla error reporting saves through its administration form';
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
