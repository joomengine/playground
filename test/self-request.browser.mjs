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
    const debug = await page.evaluate(async () => {
      const url = new URL('self-request-debug.php', window.playground.baseUrl).href;
      await window.playground.fs.writeFile('/persist/www/self-request-debug.php', `<?php
$curl = curl_init(${JSON.stringify(new URL('self-request-result.txt', window.playground.baseUrl).href)});
curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>60]);
$result = curl_exec($curl);
file_put_contents('/persist/www/self-debug-result.txt', $result);
echo $result;`);
      await window.playground.debugger.start({ url });
      const response = await fetch(url);
      return { status: response.status, text: await response.text(), state: window.playground.debugger.state,
        written: new TextDecoder().decode(await window.playground.fs.readFile('/persist/www/self-debug-result.txt')) };
    });
    assert.deepEqual(debug, { status: 200, text: 'child-complete', state: 'idle', written: 'child-complete' });
    await page.evaluate(() => window.playground.close());
  });
}
