import assert from 'node:assert/strict';
import { startRedirectTrace, recordVerifiedRedirectDiagnostic } from './firefox-redirect-probe.mjs';

export async function readCapturedBrowserMail(page, count, { timeoutMs = 30_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    // Playwright waitForFunction treats a Promise as truthy before awaiting its value.
    const snapshot = await page.evaluate(async () => ({
      state: window.playground.mail.state, entries: await window.playground.mail.list(),
    }));
    for (const entry of snapshot.entries) {
      assert.notEqual(entry.parseStatus, 'error', `Mail ${entry.id} failed MIME parsing: ${entry.parseError ?? 'No parser diagnostic.'}`);
    }
    if (snapshot.state.count === count && snapshot.entries.length === count
      && snapshot.entries.every(entry => entry.parseStatus === 'ready')) break;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${count} ready captured messages: ${JSON.stringify(snapshot)}`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  const entries = await page.evaluate(async () => Promise.all((await window.playground.mail.list()).map(async summary => {
    const entry = await window.playground.mail.get(summary.id);
    return { ...entry, raw: Array.from(entry.raw) };
  })));
  assert.equal(entries.length, count);
  for (const entry of entries) assert.equal(entry.parseStatus, 'ready', `Mail ${entry.id} has parse status ${entry.parseStatus}: ${entry.parseError ?? 'No parser error.'}`);
  return entries;
}

/** Drive Joomla's own forms and templates without replacing its configured mailer. */
export async function assertJoomlaMailCapture(page, { redirectProbe } = {}) {
  const { site, email, initialCount, configuration } = await page.evaluate(async () => ({
    site: window.playground.baseUrl,
    email: window.playground.installation.administrator.email,
    initialCount: window.playground.mail.state.count,
    configuration: Array.from(await window.playground.fs.readFile('/persist/www/configuration.php')),
  }));
  assert.match(email, /\.invalid$/);
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'mail-contract-frame'; frame.style.cssText = 'width:100%;height:900px;border:0';
    document.body.append(frame);
  });
  const frame = await (await page.locator('#mail-contract-frame').elementHandle()).contentFrame();
  let complete = false;
  try {
    page.testStep = 'send real Joomla Global Configuration test mail';
    const response = await frame.goto(new URL('administrator/index.php?option=com_config', site).href, { waitUntil: 'load' });
    assert.equal(response.status(), 200);
    await frame.getByRole('tab', { name: 'Server', exact: true }).click();
    const [sent] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.href.startsWith(site) && url.searchParams.get('option') === 'com_config'
          && /^(?:application|mail)\.sendtestmail$/.test(url.searchParams.get('task') ?? '');
      }),
      frame.locator('#sendtestmail').click(),
    ]);
    assert.equal(sent.status(), 200);
    assert.equal((await sent.json()).data, true, 'The native controller must report accepted mail.');
    const entries = await readCapturedBrowserMail(page, initialCount + 1);
    const testMail = entries[0];
    assert.match(testMail.subject, /^Test mail from /);
    assert.ok(testMail.parsed.to.some(address => address.address === email));
    assert.match(testMail.parsed.text, /This is a test mail sent using/);

    page.testStep = 'request a real Joomla password reset for a Registered user';
    await page.evaluate(async () => {
      const { runStartupCommand } = await import('./src/joomla/index.mjs');
      await runStartupCommand(window.playground, [
        'user:add', '--username=mailreset', '--name=Mail reset fixture',
        '--email=reset-recipient@example.invalid', '--password=Reset-fixture-password-123!', '--usergroup=Registered',
      ]);
    });
    const beforeReset = await page.evaluate(() => window.playground.mail.state.count);
    await frame.goto(new URL('index.php?option=com_users&view=reset', site).href, { waitUntil: 'load' });
    await frame.locator('#jform_email').fill('reset-recipient@example.invalid');
    const consoleFrom = page.consoleErrors?.length ?? 0;
    const traceFrom = await startRedirectTrace(page);
    const [resetResponse] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'load' }),
      frame.locator('form#user-registration button[type="submit"]').click(),
    ]);
    assert.equal(resetResponse.status(), 200);
    if (page.consoleErrors) await recordVerifiedRedirectDiagnostic(page, {
      probe: redirectProbe, kind: 'post303', from: consoleFrom, traceFrom,
      sourceURL: new URL('service-worker.mjs', page.url()).href, step: page.testStep,
      finalURL: frame.url(), responseStatus: resetResponse.status(), methodAfterRedirect: resetResponse.request().method(),
    });
    const reset = (await readCapturedBrowserMail(page, beforeReset + 1))[0];
    assert.match(reset.subject, /password reset request$/);
    assert.ok(reset.parsed.to.some(address => address.address === 'reset-recipient@example.invalid'));
    const token = /verification code is\s+([a-f\d]+)/i.exec(reset.parsed.text)?.[1];
    assert.ok(token, 'A generic reset confirmation is insufficient; the real token must be captured.');
    assert.ok(reset.parsed.text.includes(site), 'Reset mail must point back to this local Joomla site.');
    assert.ok(reset.parsed.text.includes(token));
    const after = await page.evaluate(async () => Array.from(await window.playground.fs.readFile('/persist/www/configuration.php')));
    assert.deepEqual(after, configuration, 'Mail capture must not rewrite Joomla transport configuration.');
    complete = true;
    return { testMail: true, passwordReset: true, count: beforeReset + 1 };
  } finally {
    // Keep an unsuccessful native form available in the runner's diagnostics.
    if (complete) await page.locator('#mail-contract-frame').evaluate(element => element.remove());
  }
}
