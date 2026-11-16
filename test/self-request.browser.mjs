import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createStaticServer, prepareBrowserEnvironment } from './server.mjs';
import { callbackSource, redirectSource, selfRequestSource, assertSelfRequest, cancelledCallbackSource, cancellationSource, assertCancelledRequest } from './self-request-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`${name}: real PHP can call its own site without blocking the owner queue`, { timeout: 480_000 }, async t => {
    const server = await createStaticServer({ directory: process.env.PLAYGROUND_DIST || path.join(root, 'dist'),
      fixtures: { 'slow.txt': () => new Promise(() => {}) } });
    const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
    const browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    t.after(async () => { await browser.close(); await server.close(); });
    const page = await browser.newPage();
    if (process.env.PLAYGROUND_SELF_REQUEST_DEBUG) {
      page.on('console', message => console.error(message.text()));
      page.on('pageerror', error => console.error(error));
      page.on('requestfailed', request => console.error(request.url(), request.failure()));
    }
    await page.goto(new URL('__test__.html', server.url).href);
    await prepareBrowserEnvironment(page);
    const siteURL = await page.evaluate(async ({ callbackSource, redirectSource }) => {
      const { createPlayground } = await import('./src/playground.mjs');
      window.playground = await createPlayground({ phpVersion: '8.4', persistence: false,
        admin: { username: 'callbacktester', password: 'Callback-fixture-2026!' } });
      await window.playground.fs.writeFile('/persist/www/self-request-callback.php', callbackSource);
      await window.playground.fs.writeFile('/persist/www/self-request-redirect.php', redirectSource);
      await window.playground.runPhp("<?php setcookie('owner_cookie', 'retain');");
      return window.playground.baseUrl;
    }, { callbackSource, redirectSource });
    const response = await page.evaluate(source => window.playground.runPhp(source), selfRequestSource(siteURL));
    assert.equal(response.status, 200, response.text);
    assertSelfRequest(assert, JSON.parse(response.text));
    assert.deepEqual(await page.evaluate(async () => JSON.parse((await window.playground.runPhp("<?php echo json_encode([$_COOKIE['owner_cookie'] ?? '', isset($_COOKIE['child_callback'])]);")).text)), ['retain', false]);
    await page.evaluate(source => window.playground.fs.writeFile('/persist/www/self-request-cancel.php', source), cancelledCallbackSource(new URL('slow.txt', server.url).href));
    assertCancelledRequest(assert, JSON.parse((await page.evaluate(source => window.playground.runPhp(source), cancellationSource(siteURL, 15000))).text));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await page.evaluate(async () => new TextDecoder().decode(await window.playground.fs.readFile('/persist/www/self-cancel-result.txt'))), 'parent-after-cancel');
    assert.equal(await page.evaluate(async () => (await window.playground.runPhp('<?php echo 6 * 7;')).text), '42');
    const mailBaseline = await page.evaluate(async () => {
      window.debugMailStates = [];
      window.removeDebugMailObserver = window.playground.mail.subscribe(state => window.debugMailStates.push(state));
      const url = new URL('self-request-debug.php', window.playground.baseUrl).href;
      await window.playground.fs.writeFile('/persist/www/self-request-debug-mail.php', `<?php
if (!mail('nested-debug@example.invalid', 'Nested debugger mail', 'Nested debugger body: Grüße 日本語', 'From: debug-author@example.invalid')) {
    throw new RuntimeException('Nested debugger mail was not captured.');
}
echo file_get_contents('/persist/www/self-request-result.txt');`);
      const source = `<?php
if (!mail('direct-debug@example.invalid', 'Debugger mail', 'Direct debugger body: Grüße 日本語', 'From: debug-author@example.invalid')) {
    throw new RuntimeException('Debugger mail was not captured.');
}
$curl = curl_init(${JSON.stringify(new URL('self-request-debug-mail.php', window.playground.baseUrl).href)});
curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>60]);
$result = curl_exec($curl);
file_put_contents('/persist/www/self-debug-result.txt', $result);
echo $result;`;
      await window.playground.fs.writeFile('/persist/www/self-request-debug.php', source);
      await window.playground.debugger.setBreakpoints('/persist/www/self-request-debug.php',
        [{ line: source.split('\n').indexOf('echo $result;') + 1 }]);
      await window.playground.debugger.start({ url });
      const count = window.playground.mail.state.count;
      window.debugMailResponse = fetch(url).then(async response => ({ status: response.status, text: await response.text() }));
      window.debugMailResponse.catch(error => { window.debugMailFailure = error.message; });
      return count;
    });
    await page.waitForFunction(() => window.playground.debugger.state === 'paused' || window.debugMailFailure,
      null, { timeout: 120_000 });
    assert.equal(await page.evaluate(() => window.debugMailFailure), undefined);
    const pausedMail = await page.evaluate(async () => {
      // These reads must resolve while the debugger still owns the PHP queue.
      let timer;
      try {
        return await Promise.race([(async () => {
          const summaries = await window.playground.mail.list();
          const messages = await Promise.all(summaries.slice(0, 2).map(item => window.playground.mail.get(item.id)));
          const raw = messages.map(item => new TextDecoder().decode(item.raw));
          const original = messages[0].raw[0];
          messages[0].raw[0] ^= 255;
          const isolated = (await window.playground.mail.get(messages[0].id)).raw[0] === original;
          window.debugMailRaw = messages.map((item, index) => ({ id: item.id, raw: raw[index] }));
          return { count: window.playground.mail.state.count, state: window.playground.debugger.state,
            hasRawSummary: summaries.some(item => Object.hasOwn(item, 'raw')), raw, isolated };
        })(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Inbox reads blocked behind paused PHP.')), 10_000);
        })]);
      } finally { clearTimeout(timer); }
    });
    assert.equal(pausedMail.state, 'paused');
    assert.equal(pausedMail.count, mailBaseline + 2, 'Both the debugger and its nested PHP request must reach the owner mailbox exactly once.');
    assert.equal(pausedMail.hasRawSummary, false);
    assert.equal(pausedMail.isolated, true, 'Inbox reads must return copies of retained raw MIME.');
    assert.ok(pausedMail.raw.every(raw => raw.includes('From: debug-author@example.invalid')));
    assert.match(pausedMail.raw[0], /To: nested-debug@example\.invalid/);
    assert.match(pausedMail.raw[0], /Subject: Nested debugger mail/);
    assert.match(pausedMail.raw[0], /Nested debugger body: Grüße 日本語/);
    assert.match(pausedMail.raw[1], /To: direct-debug@example\.invalid/);
    assert.match(pausedMail.raw[1], /Subject: Debugger mail/);
    assert.match(pausedMail.raw[1], /Direct debugger body: Grüße 日本語/);
    const debug = await page.evaluate(async () => {
      await window.playground.debugger.setBreakpoints('/persist/www/self-request-debug.php', []);
      await window.playground.debugger.continue();
      const response = await window.debugMailResponse;
      return { ...response, state: window.playground.debugger.state,
        written: new TextDecoder().decode(await window.playground.fs.readFile('/persist/www/self-debug-result.txt')) };
    });
    assert.deepEqual(debug, { status: 200, text: 'child-complete', state: 'idle', written: 'child-complete' });
    const retainedMail = await page.evaluate(async () => {
      const unchanged = await Promise.all(window.debugMailRaw.map(async item =>
        new TextDecoder().decode((await window.playground.mail.get(item.id)).raw) === item.raw));
      const count = window.playground.mail.state.count;
      const observedCount = Math.max(...window.debugMailStates.map(state => state.count));
      window.removeDebugMailObserver();
      await window.playground.mail.clear();
      return { unchanged, count, observedCount, cleared: window.playground.mail.state.count,
        remaining: await window.playground.mail.list() };
    });
    assert.deepEqual(retainedMail, { unchanged: [true, true], count: mailBaseline + 2,
      observedCount: mailBaseline + 2, cleared: 0, remaining: [] });
    await page.evaluate(() => window.playground.close());
  });
}
