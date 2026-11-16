import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';
import { createStaticServer } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const engines = { chromium, firefox, webkit };
const browsers = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox,webkit').split(',');

async function waitForParsedInbox(page, count) {
  const deadline = Date.now() + 30_000;
  let messages = [];
  do {
    // waitForFunction does not await async predicates in this Playwright build.
    messages = await page.evaluate(() => window.mailbox.mail.list());
    for (const message of messages) assert.notEqual(message.parseStatus, 'error', message.parseError);
    if (messages.length === count && messages.every(message => message.parseStatus === 'ready')) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`Mail previews did not finish: expected ${count} ready messages, received ${JSON.stringify(messages)}`);
}

for (const name of browsers) {
  test(`mail inbox preserves raw bytes, selection and isolated previews (${name})`, { timeout: 90_000 }, async () => {
    assert.ok(engines[name], `Unsupported browser: ${name}`);
    const bundled = await build({ entryPoints: [new URL('../src/mail/parser.mjs', import.meta.url).pathname],
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false });
    let remoteRequests = 0;
    const server = await createStaticServer({ directory: root, fixtures: {
      'assets/mail/parser.mjs': bundled.outputFiles[0].text,
      'tracker.png': () => { remoteRequests++; return 'tracking must be blocked'; },
      'tracker.css': () => { remoteRequests++; return 'body{background:red}'; },
      'tracker.html': () => { remoteRequests++; return '<p>must not navigate</p>'; },
    } });
    let browser, context;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await engines[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${server.url}__test__.html`);
      await page.evaluate(async () => {
        const [{ createSessionMailbox }, { createMailController }, { decorateAction }, { t }] = await Promise.all([
          import('./src/mail/mailbox.mjs'), import('./src/mail/dialog.mjs'), import('./src/icons.mjs'), import('./src/i18n.mjs'),
        ]);
        const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = './src/styles.css'; document.head.append(style);
        document.body.innerHTML = '<nav class="header-actions"><button id="database-button">DB</button><button id="mail-button" class="tool-button"><span data-i18n="mail.label">Mail</span><b id="mail-count" class="mail-count" aria-hidden="true" hidden>0</b></button></nav>';
        window.mailbox = createSessionMailbox(); window.capture = window.mailbox.activateGeneration('owner');
        window.uiErrors = []; window.__mailAttack = false;
        const button = document.querySelector('#mail-button'); decorateAction(button, 'mail');
        window.controller = createMailController({ button, badge: document.querySelector('#mail-count'), t,
          onError: error => window.uiErrors.push(error.message) });
        window.controller.bind(window.mailbox.mail, 'owner');
        window.addMessage = (id, subject, html = '<p>Safe HTML</p>') => {
          const source = `From: =?UTF-8?B?Sm9vbUVuZ2luZSDwn5qA?= <sender@example.invalid>\r\nTo: recipient@example.invalid\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=mailtest\r\n\r\n--mailtest\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain body ${id}\r\n--mailtest\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--mailtest--\r\n`;
          const raw = new Uint8Array([...new TextEncoder().encode(source), 0, 255, 128]);
          window.capture({ captureId: id, version: 1, raw, command: '/usr/sbin/sendmail -t -i', args: ['-t', '-i'],
            envelopeSender: 'bounce@example.invalid', envelopeRecipients: [], readRecipientsFromHeaders: true });
          return Array.from(raw);
        };
      });
      assert.equal(await page.locator('#mail-count').isVisible(), false);
      const malicious = `<p id="safe">Visible email content</p><script>parent.__mailAttack=true</script>
        <img src="${server.url}tracker.png"><img srcset="${server.url}tracker.png 1x">
        <img alt="Safe raster" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6YsAAAAASUVORK5CYII=">
        <img alt="Blocked SVG" src="data:image/svg+xml;base64,PHN2Zy8+">
        <style>@import url('${server.url}tracker.css');</style><div style="background-image:url('${server.url}tracker.png')">Styled</div>
        <meta http-equiv="refresh" content="0;url=${server.url}tracker.html"><base href="${server.url}tracker.html">
        <link rel="stylesheet" href="${server.url}tracker.css"><iframe src="${server.url}tracker.html"></iframe>
        <iframe srcdoc="<script>parent.__mailAttack=true</script>"></iframe>
        <svg xmlns="http://www.w3.org/2000/svg" onload="parent.__mailAttack=true"><image href="${server.url}tracker.png"/></svg>
        <form action="${server.url}tracker.html"><input autofocus onfocus="parent.__mailAttack=true"><button>Submit attack</button></form>
        <a id="unsafe-link" href="${server.url}tracker.html" target="_top" onclick="parent.__mailAttack=true">Link text</a>`;
      const raw = await page.evaluate(html => window.addMessage('one', '<img src=x onerror=alert(1)>', html), malicious);
      await page.waitForFunction(() => window.mailbox.mail.state.count === 1);
      await page.locator('#mail-button').click();
      await waitForParsedInbox(page, 1);
      await page.locator('.mail-source').filter({ hasText: 'Plain body one' }).waitFor();
      assert.equal(await page.locator('#mail-count').textContent(), '1');
      assert.equal(await page.locator('.mail-subject').textContent(), '<img src=x onerror=alert(1)>');
      assert.equal(await page.locator('.mail-subject img').count(), 0);
      await page.locator('#mail-tab-html').click();
      const frame = page.frameLocator('.mail-html');
      await frame.getByText('Visible email content', { exact: true }).waitFor();
      assert.equal(await page.locator('.mail-html').getAttribute('sandbox'), '');
      assert.equal(await page.locator('.mail-html').getAttribute('referrerpolicy'), 'no-referrer');
      assert.equal(await frame.locator('script,iframe,form,svg,math,base,link,body meta').count(), 0);
      assert.equal(await frame.getByText('Link text', { exact: true }).getAttribute('href'), null);
      assert.match(await frame.getByAltText('Safe raster').getAttribute('src'), /^data:image\/png;base64,/);
      assert.equal(await frame.getByAltText('Blocked SVG').getAttribute('src'), null);
      assert.equal(await page.evaluate(() => window.__mailAttack), false);
      await page.waitForTimeout(250);
      assert.equal(remoteRequests, 0, 'Parsing and rendering must not contact remote image, stylesheet or navigation URLs.');
      assert.equal(await page.evaluate(async () => {
        const { mailPreviewDocument } = await import('./src/mail/preview.mjs');
        return mailPreviewDocument('<div>'.repeat(3000) + 'Deep email' + '</div>'.repeat(3000)).includes('Deep email');
      }), true, 'Deep HTML can still be inspected without recursive JavaScript traversal.');
      await page.locator('.mail-row').focus();
      await page.evaluate(() => { window.originalMailFrame = document.querySelector('.mail-html'); });
      const selected = await page.locator('.mail-row[aria-pressed=true]').getAttribute('data-mail-id');
      await page.evaluate(() => window.addMessage('two', 'Second message'));
      await page.waitForFunction(() => document.querySelector('#mail-count').textContent === '2');
      await waitForParsedInbox(page, 2);
      assert.equal(await page.locator('.mail-row[aria-pressed=true]').getAttribute('data-mail-id'), selected);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.mailId), selected, 'New mail preserves the focused message.');
      assert.equal(await page.evaluate(() => document.querySelector('.mail-html') === window.originalMailFrame), true,
        'New captures and their parser updates preserve the existing preview and its scroll position.');
      await page.locator('#mail-tab-raw').click();
      assert.match(await page.locator('.mail-source').textContent(), /Plain body one/);
      const downloading = page.waitForEvent('download'); await page.locator('#mail-download').click();
      const downloaded = await downloading;
      assert.deepEqual(new Uint8Array(await readFile(await downloaded.path())), Uint8Array.from(raw));
      await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
      await page.screenshot({ path: new URL(`../test-results/mail-ui-${name}.png`, import.meta.url).pathname });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.querySelector('#mail-dialog').scrollWidth <= document.querySelector('#mail-dialog').clientWidth + 1), true);
      await page.screenshot({ path: new URL(`../test-results/mail-ui-${name}-mobile.png`, import.meta.url).pathname });
      await page.locator('#mail-clear').click();
      await page.locator('.mail-empty').waitFor();
      assert.equal(await page.locator('#mail-count').isVisible(), false);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#mail-dialog').isVisible(), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'mail-button');
      await page.evaluate(async () => {
        const { createSessionMailbox } = await import('./src/mail/mailbox.mjs');
        window.mailbox.close();
        window.mailbox = createSessionMailbox({ parseMail: async () => { throw new Error('Deliberate preview failure'); } });
        window.controller.bind(window.mailbox.mail, 'replacement-owner');
        const second = window.mailbox.activateGeneration('replacement-worker');
        second({ captureId: 'broken', version: 1, raw: new TextEncoder().encode('invalid MIME'), command: '/usr/sbin/sendmail', args: [],
          envelopeSender: null, envelopeRecipients: [], readRecipientsFromHeaders: false });
      });
      await page.locator('#mail-button').click();
      assert.equal(await page.locator('#mail-count').textContent(), '1');
      await page.getByText('Preview unavailable: Deliberate preview failure', { exact: false }).waitFor();
      await page.locator('#mail-tab-raw').click();
      assert.equal(await page.locator('.mail-source').textContent(), 'invalid MIME');
      await page.evaluate(() => {
        const previous = window.mailbox.mail;
        window.controller.bind({ get state() { return previous.state; },
          list: () => previous.list(), clear: () => previous.clear(), subscribe: listener => previous.subscribe(listener),
          async get(id) { const detail = await previous.get(id); return new Promise(resolve => { window.releaseMailDetail = () => resolve(detail); }); },
        }, 'delayed-owner');
      });
      await page.locator('#mail-button').click();
      await page.waitForFunction(() => typeof window.releaseMailDetail === 'function');
      await page.evaluate(async () => {
        const { createSessionMailbox } = await import('./src/mail/mailbox.mjs');
        window.mailbox.close(); window.mailbox = createSessionMailbox();
        window.capture = window.mailbox.activateGeneration('current-worker');
        window.controller.bind(window.mailbox.mail, 'current-owner');
        window.addMessage('current', 'Current owner message');
      });
      await page.locator('#mail-button').click();
      await page.locator('.mail-subject').filter({ hasText: 'Current owner message' }).waitFor();
      await page.evaluate(() => window.releaseMailDetail());
      assert.equal(await page.locator('.mail-subject').textContent(), 'Current owner message',
        'An awaited detail from a retired runtime cannot replace the current message.');
      await page.evaluate(() => { window.controller.bind(undefined, undefined); window.mailbox.close(); });
      assert.equal(await page.locator('#mail-button').isDisabled(), true);
      assert.equal(await page.locator('#mail-dialog').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.uiErrors), []);
      assert.deepEqual(errors, []);
    } finally { await context?.close(); await browser?.close(); await server.close(); }
  });
}
