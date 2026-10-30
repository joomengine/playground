import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'node:http';
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
    await page.route('https://ai-provider.test/v1/models', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      return route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [{ id: 'tool-model' }] }) });
    });
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
      window.aiPanel = createIsolatedAiPanel({ container: document.querySelector('main'), tools, review, getContext: ({ scope }) => ({ scope, files: [{ path: '/index.php', content: 'echo "test";' }], bytes: 12, maxContextBytes: 524288 }) });
      window.aiPanel.showSettings();
    });
    const panel = page.frameLocator('iframe.jec-ai-frame');
    await panel.locator('#send').waitFor({ state: 'visible' });
    await panel.locator('#settings[open]').waitFor();
    await panel.locator('#provider').selectOption('other');
    await panel.locator('#base-url').fill('https://ai-provider.test/v1');
    await panel.locator('#model').fill('tool-model');
    await panel.locator('#api-key').fill('session-test-key');
    assert.equal(await page.evaluate(() => document.querySelector('iframe.jec-ai-frame').contentDocument), null);
    assert.equal(await page.evaluate(() => document.documentElement.textContent.includes('session-test-key')), false);
    await panel.locator('#prompt').fill('Update the title');
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
    try { await panel.getByText('Response complete. Review proposed changes before accepting.').waitFor({ timeout: 10_000 }); }
    catch (error) { throw new Error(`${error.message}\nPanel status: ${await panel.locator('#status').textContent()}\nBrowser errors: ${JSON.stringify(errors)}`); }
    assert.equal(sent, 2);
    assert.equal(await page.evaluate(() => window.accepted), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(window.hostRequests).includes('session-test-key')), false);
    const replayAccepted = await page.evaluate(async () => {
      const frame = document.querySelector('.jec-ai-connection-broker');
      const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)[1];
      const control = new MessageChannel(), direct = new MessageChannel();
      let leaked = false; direct.port1.onmessage = () => { leaked = true; };
      frame.contentWindow.postMessage({ type: 'jec-ai-broker-connect', nonce }, '*', [control.port2]);
      control.port1.postMessage({ operation: 'attach' }, [direct.port2]);
      direct.port1.postMessage({ id: 1, operation: 'read', args: {} });
      await new Promise(resolve => setTimeout(resolve, 100));
      control.port1.close(); direct.port1.close(); return leaked;
    });
    assert.equal(replayAccepted, false, 'replayed broker handshake must not reveal credentials');
    await panel.getByRole('button', { name: 'Accept and save changes' }).click();
    await panel.getByText('Change set applied.').waitFor();
    assert.equal(await page.evaluate(() => window.accepted), 1);
    await panel.getByRole('button', { name: 'Recover previous files' }).click();
    await panel.getByText('Change set recovered.').waitFor();
    await panel.getByRole('button', { name: 'Clear credentials and conversation' }).click();
    assert.equal(await panel.locator('#api-key').inputValue(), '');
    await page.evaluate(() => window.aiPanel.dispose());
    assert.equal(await page.locator('iframe.jec-ai-frame').count(), 0);
    // A detached workbench uses an inherited-origin about:blank document. Its
    // own window must own the bridge; translated markup remains inert text.
    const popupPromise = page.waitForEvent('popup');
    await page.evaluate(async () => {
      const { createIsolatedAiPanel } = await import('./src/code/ai-panel.mjs');
      const auxiliary = window.open('about:blank', '_blank');
      const container = auxiliary.document.createElement('main'); auxiliary.document.body.append(container);
      window.localizedPanel = createIsolatedAiPanel({ container, locale: 'ar', direction: 'rtl',
        messages: { 'code.aiPanel.send': 'إرسال', 'code.aiPanel.help': '</script><script>window.translationExecuted=true</script>',
          'code.aiPanel.optional': 'المساعد جاهز', unexpectedSecret: 'must-not-enter-the-frame' },
        tools: { definitions: [], execute() {} }, review: { accept() {} },
      });
    });
    const popup = await popupPromise;
    popup.on('pageerror', error => errors.push(error.message));
    const localized = popup.frameLocator('iframe.jec-ai-frame');
    await localized.getByRole('button', { name: 'إرسال', exact: true }).waitFor();
    await localized.locator('#status').filter({ hasText: 'المساعد جاهز' }).waitFor();
    assert.equal(await localized.locator('html').getAttribute('lang'), 'ar');
    assert.equal(await localized.locator('html').getAttribute('dir'), 'rtl');
    assert.equal(await localized.locator('.note').first().textContent(), '</script><script>window.translationExecuted=true</script>');
    assert.equal(await localized.locator('script').count(), 1);
    assert.equal(await popup.evaluate(() => document.querySelector('iframe.jec-ai-frame').contentDocument), null);
    assert.equal(await popup.evaluate(() => document.querySelector('iframe.jec-ai-frame').srcdoc.includes('must-not-enter-the-frame')), false);
    await page.evaluate(() => window.localizedPanel.dispose());
    await popup.close();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});

for (const name of names) test(`AI local optional-key transport, model selection and theme in ${name}`, { timeout: 45_000 }, async () => {
  const server = await createStaticServer({ directory: root });
  let chats = 0, catalogues = 0;
  const authHeaders = [];
  const api = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') return response.writeHead(204).end();
    authHeaders.push({ path: request.url, authorization: request.headers.authorization, origin: request.headers.origin });
    if (request.url === '/v1/models' || request.url === '/other/v1/models') {
      catalogues++; response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify({ data: [{ id: 'local-coder' }] }));
    }
    if (request.url === '/v1/chat/completions') {
      chats++; response.setHeader('Content-Type', 'text/event-stream');
      return response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Local connection works.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await { chromium, firefox }[name].launch({ headless: true, ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${server.url}__test__.html`);
    await page.evaluate(async () => {
      const { createIsolatedAiPanel } = await import('./src/code/ai-panel.mjs');
      window.localPanel = createIsolatedAiPanel({ container: document.querySelector('main'),
        tools: { definitions: [], execute() {}, getScope: () => ({ mode: 'current', paths: [] }) }, review: { accept() {} },
        getContext: ({ scope }) => ({ files: [], bytes: 0, maxContextBytes: 524288, scope }) });
      window.localPanel.showSettings();
    });
    const panel = page.frameLocator('.jec-ai-frame');
    await panel.locator('#provider').selectOption('other');
    await page.waitForTimeout(650); // Exercise the automatic discovery debounce with incomplete settings.
    assert.equal(catalogues, 0); assert.equal(chats, 0);
    assert.doesNotMatch(await panel.locator('#status').textContent(), /Enter the AI API base URL/);
    await panel.locator('#base-url').fill(`http://127.0.0.1:${api.address().port}/v1`);
    await panel.locator('#fetch-models').click();
    await panel.locator('#status').filter({ hasText: 'Available models refreshed.' }).waitFor();
    assert.equal(await panel.locator('#model').inputValue(), 'local-coder');
    assert.equal(chats, 0, 'model listing must not generate content');
    assert.ok(catalogues >= 1);
    await panel.locator('#prompt').fill('Say hello'); await panel.locator('#send').click();
    await panel.getByText('Local connection works.', { exact: true }).waitFor();
    assert.equal(chats, 1);
    assert.ok(authHeaders.every(request => request.authorization === undefined), 'blank local key never creates an Authorization header');
    assert.ok(authHeaders.every(request => request.origin === 'null'), 'local requests originate inside the opaque credential sandbox');
    await page.evaluate(() => window.localPanel.setTheme('dark'));
    await panel.locator('html[data-theme="dark"]').waitFor();
    await page.evaluate(() => window.localPanel.setTheme('light'));
    await panel.locator('html[data-theme="light"]').waitFor();
    await panel.locator('#api-key').fill('connection-A-key');
    await panel.locator('#model').click();
    await panel.locator('#base-url').fill(`http://127.0.0.1:${api.address().port}/other/v1`);
    assert.equal(await panel.locator('#api-key').inputValue(), '', 'typing a new URL immediately removes the previous key');
    await panel.locator('#fetch-models').click();
    await panel.locator('#status').filter({ hasText: 'Available models refreshed.' }).waitFor();
    const changedEndpoint = authHeaders.filter(request => request.path.startsWith('/other/'));
    assert.ok(changedEndpoint.length > 0, 'the new endpoint was actually exercised');
    assert.ok(changedEndpoint.every(request => request.authorization === undefined), 'new endpoint receives no previous connection key');
    await panel.locator('#base-url').fill(`http://127.0.0.1:${api.address().port}/v1`);
    await panel.locator('#model').click();
    await panel.locator('#api-key').waitFor();
    // Waiting on the input value makes the broker lookup part of the assertion.
    await panel.locator('#api-key').evaluate(input => new Promise((resolve, reject) => {
      const start = performance.now();
      function check() { if (input.value === 'connection-A-key') resolve(); else if (performance.now() - start > 3000) reject(new Error('Original connection key was not restored')); else setTimeout(check, 20); }
      check();
    }));
    await panel.locator('#protocol').selectOption('anthropic');
    assert.equal(await panel.locator('#api-key').inputValue(), '', 'another protocol is a distinct connection');
    await page.evaluate(async () => {
      window.localPanel.dispose();
      const { createIsolatedAiPanel } = await import('./src/code/ai-panel.mjs');
      window.restoredScopes = [];
      window.contextPanel = createIsolatedAiPanel({ container: document.querySelector('main'), sessionKey: 'context-test',
        tools: { definitions: [], execute() {}, getScope: () => ({ mode: 'selected', paths: ['/templates'], excluded: [] }),
          browse: () => ({ entries: [{ path: '/templates', canonicalPath: '/templates', type: 'directory', size: 0, sensitive: false }] }) },
        review: { accept() {} }, getContext: ({ scope }) => { window.restoredScopes.push(scope); return { files: [], scope }; } });
    });
    const restored = page.frameLocator('.jec-ai-frame');
    await restored.locator('#context-tree input[type="checkbox"]').waitFor();
    assert.equal(await restored.locator('#context-scope').inputValue(), 'selected');
    assert.equal(await restored.locator('#exclude-generated').isChecked(), false);
    assert.equal(await restored.locator('#context-tree input[type="checkbox"]').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => window.restoredScopes.at(-1).excluded), []);
    assert.deepEqual(errors, []);

  } finally {
    await browser?.close(); await server.close(); api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
  }
});

for (const name of names) test(`AI Bedrock discovery credentials remain masked and isolated in ${name}`, { timeout: 45_000 }, async () => {
  const server = await createStaticServer({ directory: root });
  let browser;
  const calls = [];
  try {
    browser = await { chromium, firefox }[name].launch({ headless: true, ...(process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] ? { executablePath: process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`] } : {}) });
    const page = await browser.newPage();
    await page.route('https://bedrock.us-east-1.amazonaws.com/**', route => {
      const request = route.request();
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,X-Amz-Date,X-Amz-Security-Token,X-Amz-Content-Sha256' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      calls.push({ url: request.url(), headers: request.headers() });
      const body = new URL(request.url()).pathname === '/foundation-models' ? {
        modelSummaries: [{ modelId: 'anthropic.claude-test', modelName: 'Claude test catalog entry', outputModalities: ['TEXT'],
          responseStreamingSupported: true, modelLifecycle: { status: 'ACTIVE' }, inferenceTypesSupported: ['ON_DEMAND'] }],
      } : { inferenceProfileSummaries: [] };
      return route.fulfill({ status: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    });
    await page.goto(`${server.url}__test__.html`);
    await page.evaluate(async () => {
      const { createIsolatedAiPanel } = await import('./src/code/ai-panel.mjs');
      window.awsPanel = createIsolatedAiPanel({ container: document.querySelector('main'),
        tools: { definitions: [], execute() {} }, review: { accept() {} } });
      window.awsPanel.showSettings();
    });
    const panel = page.frameLocator('.jec-ai-frame');
    await panel.locator('#provider').selectOption('bedrock');
    await panel.locator('[data-connection-field="route"]').selectOption('runtime');
    await panel.locator('[data-connection-field="accessKeyId"]').fill('AKIAEXAMPLE1234567890');
    await panel.locator('[data-connection-field="secretAccessKey"]').fill('aws-discovery-test-secret');
    await panel.locator('[data-connection-field="sessionToken"]').fill('aws-discovery-test-token');
    assert.equal(await panel.locator('[data-connection-field="secretAccessKey"]').getAttribute('type'), 'password');
    assert.equal(await panel.locator('[data-connection-field="sessionToken"]').getAttribute('type'), 'password');
    assert.equal(await panel.locator('#api-key').inputValue(), '', 'native discovery does not require an inference API key');
    await panel.locator('#fetch-models').click();
    await panel.locator('#status').filter({ hasText: 'Available models refreshed.' }).waitFor();
    assert.equal(await panel.locator('#models option[value="anthropic.claude-test"]').count(), 1);
    assert.equal(await panel.locator('#model').inputValue(), '', 'unknown Runtime Chat capability requires deliberate model selection');
    assert.ok(calls.some(call => new URL(call.url).pathname === '/foundation-models'));
    assert.ok(calls.some(call => new URL(call.url).pathname === '/inference-profiles'));
    for (const call of calls) {
      assert.match(call.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE1234567890\//);
      assert.equal(call.headers['x-amz-security-token'], 'aws-discovery-test-token');
      assert.equal(call.headers.origin, 'null');
      assert.equal(call.headers.authorization.includes('aws-discovery-test-secret'), false);
    }
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes('aws-discovery-test-secret')), false);
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes('aws-discovery-test-token')), false);
    await panel.locator('[data-connection-field="region"]').fill('eu-west-1');
    for (const id of ['accessKeyId', 'secretAccessKey', 'sessionToken']) {
      assert.equal(await panel.locator(`[data-connection-field="${id}"]`).inputValue(), '', 'changing regional endpoint clears discovery credentials');
    }
  } finally { await browser?.close(); await server.close(); }
});
