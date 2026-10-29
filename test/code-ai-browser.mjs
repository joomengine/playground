import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',');
for (const name of names) test(`AI credential sandbox and explicit review controls in ${name}`, { timeout: 45_000 }, async () => {
  const server = await createStaticServer({ directory: root });
  const launcher = { chromium, firefox }[name];
  assert.ok(launcher, 'Choose chromium or firefox.');
  let browser;
  try {
    browser = await launcher.launch({ headless: true, ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let sent = 0;
    await page.route('https://ai-provider.test/v1/chat/completions', route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' } });
      assert.equal(request.headers().authorization, 'Bearer session-test-key');
      assert.equal(request.headers().origin, 'null');
      assert.equal(request.postData().includes('session-test-key'), false);
      const first = ++sent === 1;
      const events = first ? [
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'review_1', type: 'function', function: { name: 'propose_changes', arguments: '{"summary":"Change title","changes":[{"operation":"write","path":"/index.php","content":"after"}]}' } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ] : [{ choices: [{ index: 0, delta: { content: 'The changes are ready for review.' }, finish_reason: 'stop' }] }];
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' },
        body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n' });
    });
    await page.goto(`${server.url}__test__.html`);
    await page.evaluate(async () => {
      const { createIsolatedAiPanel } = await import('./src/code/ai-panel.mjs');
      window.hostRequests = []; window.accepted = 0;
      const prepared = { id: 'review-1', status: 'pending', summary: 'Change title', operations: [{ operation: 'write', path: '/index.php', before: 'before', after: 'after' }] };
      const tools = { definitions: [{ type: 'function', function: { name: 'propose_changes', parameters: { type: 'object' } } }],
        execute(name, args) { window.hostRequests.push({ name, args }); return prepared; } };
      const review = { accept(id) { window.accepted++; return { ...prepared, id, status: 'applied', recoveryId: 'snapshot-1' }; },
        reject(id) { return { ...prepared, id, status: 'rejected' }; }, undo(id) { return { ...prepared, id, status: 'recovered' }; } };
      window.aiPanel = createIsolatedAiPanel({ container: document.querySelector('main'), tools, review, getContext: () => ({ selection: 'echo "test";' }) });
    });
    const panel = page.frameLocator('iframe');
    await panel.locator('#send').waitFor({ state: 'visible' });
    await panel.locator('summary').first().click();
    await panel.locator('#base-url').fill('https://ai-provider.test/v1');
    await panel.locator('#model').fill('tool-model');
    await panel.locator('#api-key').fill('session-test-key');
    assert.equal(await page.evaluate(() => document.querySelector('iframe').contentDocument), null);
    assert.equal(await page.evaluate(() => document.documentElement.textContent.includes('session-test-key')), false);
    await panel.locator('#prompt').fill('Update the title');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    try { await panel.getByText('Response complete. Review proposed changes before accepting.').waitFor({ timeout: 10_000 }); }
    catch (error) { throw new Error(`${error.message}\nPanel status: ${await panel.locator('#status').textContent()}\nBrowser errors: ${JSON.stringify(errors)}`); }
    assert.equal(sent, 2);
    assert.equal(await page.evaluate(() => window.accepted), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(window.hostRequests).includes('session-test-key')), false);
    await panel.getByRole('button', { name: 'Accept and save changes' }).click();
    await panel.getByText('Change set applied.').waitFor();
    assert.equal(await page.evaluate(() => window.accepted), 1);
    await panel.getByRole('button', { name: 'Recover previous files' }).click();
    await panel.getByText('Change set recovered.').waitFor();
    await panel.getByRole('button', { name: 'Clear credentials and conversation' }).click();
    assert.equal(await panel.locator('#api-key').inputValue(), '');
    await page.evaluate(() => window.aiPanel.dispose());
    assert.equal(await page.locator('iframe').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
