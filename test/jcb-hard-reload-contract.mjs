import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { probeSyntheticRedirect, startRedirectTrace, recordVerifiedRedirectDiagnostic } from './firefox-redirect-probe.mjs';

/** Reproduce issue #5 through the prepared JCB UI: Save must survive a page reload without Close. */
export async function assertJcbHardReload(page, { redirectProbe, timeout = 240_000 } = {}) {
  const probe = redirectProbe ?? await probeSyntheticRedirect(page.context().browser());
  const nonce = randomUUID();
  const articleTitle = `Saved JCB record ${nonce}`;
  const siteName = `Saved JCB files ${nonce}`;
  let frame = await (await page.locator('#site-frame').elementHandle()).contentFrame();
  const initialPath = frame.url().replace(/^.*\/__site\/[^/]+\/[^/]+/, '');
  const siteBase = () => {
    const match = frame.url().match(/^(.*\/__site\/[^/]+\/[^/]+\/)/);
    assert.ok(match, 'The running Joomla site must have its routed URL.');
    return match[1];
  };
  const adminPage = query => new URL(`administrator/index.php?${query}`, siteBase()).href;
  const waitForDashboard = async () => {
    // JCB starts its documentation and version fetches on delayed timers. Wait
    // for their consumed bodies before leaving, including an already-loaded
    // dashboard, so navigation does not cancel them and create unrelated errors.
    await frame.waitForFunction(() => {
      const readme = document.getElementById('readme-md');
      const documentation = document.getElementById('JcbDoc-page-md');
      const documentationError = document.getElementById('JcbDoc-page-md-error');
      const version = document.getElementById('component-update-notice');
      return readme && !readme.querySelector('.loading-dots')
        && documentation && (!documentation.querySelector('.loading-dots') || documentationError?.textContent.trim())
        && version?.innerHTML.trim();
    }, undefined, { timeout });
  };
  const credentials = async () => {
    if (!(await page.locator('#settings').isVisible())) await page.locator('#settings-toggle').click();
    await page.locator('#credentials-button').click();
    const result = { username: await page.locator('#credential-username').inputValue(), password: await page.locator('#credential-password').inputValue() };
    await page.locator('#credentials-dialog [data-close-dialog]').click();
    return result;
  };
  const saveJoomla = async task => {
    // FontFaceSet.ready has no Playwright deadline and can remain pending when
    // a browser loses a font request across a hard reload. Keep the readiness
    // assertion, but fail with a bounded browser wait so diagnostics can run.
    await frame.waitForFunction(() => document.fonts.status === 'loaded', undefined, { timeout: 30_000 });
    const from = page.consoleErrors?.length ?? 0;
    const traceFrom = await startRedirectTrace(page);
    const [response] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'load', timeout: 90_000 }),
      frame.locator(`joomla-toolbar-button[task="${task}"] button`).click(),
    ]);
    assert.equal(response.status(), 200);
    if (page.consoleErrors) await recordVerifiedRedirectDiagnostic(page, {
      probe, kind: 'post303', from, traceFrom,
      sourceURL: new URL('service-worker.mjs', page.url()).href, step: page.testStep,
      finalURL: frame.url(), responseStatus: response.status(), methodAfterRedirect: response.request().method(),
    });
  };

  page.testStep = 'prepared JCB creates a committed Joomla record before saving';
  await waitForDashboard();
  const administrator = await credentials();
  assert.ok(administrator.username && administrator.password.length >= 16);
  await frame.goto(adminPage('option=com_content&view=article&layout=edit'), { waitUntil: 'load', timeout });
  await frame.locator('#jform_title').fill(articleTitle);
  await frame.evaluate(() => {
    const text = '<p>Committed content must survive a whole-page reload without a clean database shutdown.</p>';
    const editor = window.Joomla?.editors?.instances?.jform_articletext;
    if (editor?.setValue) editor.setValue(text);
    else {
      const textarea = document.getElementById('jform_articletext');
      if (!textarea) throw new Error('The Joomla article editor did not expose its text field.');
      textarea.value = text;
    }
  });
  await saveJoomla('article.save');
  assert.match(await frame.locator('body').innerText(), /Article saved/i);

  page.testStep = 'prepared JCB writes a configuration.php marker before saving';
  await frame.goto(adminPage('option=com_config'), { waitUntil: 'load', timeout });
  const originalSiteName = await frame.locator('#jform_sitename').inputValue();
  await frame.locator('#jform_sitename').fill(siteName);
  await saveJoomla('application.apply');
  assert.equal(await frame.locator('#jform_sitename').inputValue(), siteName);
  await frame.goto(new URL(`.${initialPath}`, siteBase()).href, { waitUntil: 'load', timeout });
  await waitForDashboard();

  for (let saved = 1; saved <= 2; saved++) {
    page.testStep = `prepared JCB save ${saved} then whole-page reload without Close`;
    if (!await page.locator('#settings').isVisible()) await page.locator('#settings-toggle').click();
    await page.locator('#save-button').click();
    await page.locator('#status-message').filter({ hasText: 'Files and database saved to browser storage.' }).waitFor({ timeout });
    await page.locator('#save-button:enabled').waitFor({ timeout });
    // Intentionally do not click Close or invoke runtime.close(): either would
    // checkpoint MariaDB and conceal the live-persistence regression in issue #5.
    await page.reload({ waitUntil: 'load', timeout });
    await page.waitForFunction(() => document.getElementById('site-frame')
      || (document.getElementById('error-view') && !document.getElementById('error-view').hidden), undefined, { timeout });
    assert.equal(await page.locator('#error-view').isVisible(), false,
      `A completed Save must reopen without graceful shutdown: ${await page.locator('#error-message').textContent()}`);
    frame = await (await page.locator('#site-frame').elementHandle()).contentFrame();
    await frame.waitForURL(url => url.pathname.includes('/__site/'), { waitUntil: 'load', timeout });
    await frame.locator('body').waitFor();
    assert.equal(await frame.locator('input[name="passwd"]').count(), 0, 'Administrator access must survive reload.');
    assert.deepEqual(await credentials(), administrator, 'Saved administrator credentials must remain unchanged.');
    await waitForDashboard();
    await frame.goto(adminPage('option=com_config'), { waitUntil: 'load', timeout });
    assert.equal(await frame.locator('#jform_sitename').inputValue(), siteName, 'The saved configuration.php marker must survive reload.');
    if (saved === 2) {
      // Both reloads have proved the saved file. Restore it while this real
      // configuration form is already open, before the final record check.
      // A redundant dashboard -> configuration round trip after that check can
      // leave Firefox's automation frame context stale despite a rendered page.
      page.testStep = 'restore JCB site name in the verified configuration form after the second reload';
      await frame.locator('#jform_sitename').fill(originalSiteName);
      await saveJoomla('application.apply');
      assert.equal(await frame.locator('#jform_sitename').inputValue(), originalSiteName);
      page.testStep = 'verify the committed JCB record after the second reload and configuration restore';
    }
    await frame.goto(adminPage('option=com_content&view=articles'), { waitUntil: 'load', timeout });
    await frame.locator('#filter_search').fill(articleTitle);
    await Promise.all([
      frame.waitForNavigation({ waitUntil: 'load', timeout: 90_000 }),
      frame.locator('#filter_search').press('Enter'),
    ]);
    assert.equal(await frame.getByRole('link', { name: articleTitle, exact: true }).count(), 1,
      'The committed Joomla article must survive reload.');
    await frame.goto(new URL(`.${initialPath}`, siteBase()).href, { waitUntil: 'load', timeout });
    await waitForDashboard();
  }
  return { preparedJcb: true, hardReloadsWithoutClose: 2, committedRecord: true, savedConfigurationFile: true, administrator: true };
}
