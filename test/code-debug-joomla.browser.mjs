import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.resolve(process.env.PLAYGROUND_DIST || path.join(root, 'dist'));
const manifest = JSON.parse(await readFile(path.join(directory, 'assets/manifest.json'), 'utf8'));
const versions = (process.env.PLAYGROUND_PHP_VERSIONS || manifest.php.map(entry => entry.version).join(',')).split(',');
const browsers = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',');

async function assertNativeDebugWorkbench(page, browserName, phpVersion) {
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    await window.playground.workspace.request('write', { path: '/libraries/src/Application/AdministratorApplication.php',
      bytes: new TextEncoder().encode(window.debugOriginalApplication), overwrite: true });
    const { createCodeHost } = await import('./src/code/host.mjs');
    const { default: english } = await import('./src/locales/en.mjs');
    const host = document.createElement('main'); host.style.cssText = 'width:100%;height:100vh';
    const preview = document.createElement('section'); host.append(preview);
    document.body.style.margin = '0'; document.body.replaceChildren(host);
    window.debugUiErrors = [];
    window.debugEvents = [];
    window.codeHost = await createCodeHost({ runtime: window.playground, host, preview,
      t: key => english[key] || key,
      storage: { getItem: () => JSON.stringify({ mode: 'full' }), setItem() {} },
      getPreviewURL: () => new URL('administrator/index.php', window.playground.baseUrl).href,
      refreshSite() {
        const frame = document.createElement('iframe'); frame.id = 'debug-native-preview';
        frame.src = new URL('administrator/index.php', window.playground.baseUrl).href;
        preview.replaceChildren(frame);
      },
      onError: error => { window.debugUiErrors.push(error.message); console.error(`Code host: ${error.message}`); },
    });
    await window.codeHost.open();
  });
  const editor = page.frameLocator('iframe.jec-workbench-frame');
  await editor.locator('.monaco-workbench').click({ position: { x: 800, y: 300 } });
  await page.keyboard.press('Control+p');
  const quick = editor.locator('.quick-input-widget .quick-input-box input');
  await quick.fill('libraries/src/Application/AdministratorApplication.php');
  await editor.locator('.quick-input-list').getByText('AdministratorApplication.php', { exact: true }).first().waitFor();
  await quick.press('Enter');
  await editor.locator('.tab.active').getByText('AdministratorApplication.php', { exact: true }).waitFor();
  await editor.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+g');
  await quick.fill(`:${await page.evaluate(() => window.debugDispatchLine)}`);
  await quick.press('Enter');
  await page.keyboard.press('F9');
  await editor.locator('.monaco-editor [class*="codicon-debug-breakpoint"]').first().waitFor();
  const responsePromise = page.waitForResponse(response => response.url().includes('/__site/')
    && response.url().endsWith('/administrator/index.php') && response.request().resourceType() === 'document', { timeout: 120_000 });
  // Keep the deferred HTTP response observed while assertions inspect the pause.
  responsePromise.catch(() => {});
  await page.locator('button[data-i18n="code.debugRefresh"]').click();
  await page.waitForFunction(() => window.playground.debugger.state === 'paused');
  await editor.locator('.debug-toolbar').waitFor();
  await editor.locator('.debug-call-stack').getByText('AdministratorApplication.php', { exact: false }).first().waitFor();
  await editor.locator('.debug-variables').getByText('Locals', { exact: true }).waitFor();
  const locals = editor.locator('.debug-variables .monaco-list-row').filter({ hasText: /^Locals$/ });
  if (await locals.getAttribute('aria-expanded') === 'false') await locals.locator('.monaco-tl-twistie').click();
  const application = editor.locator('.debug-variables .monaco-list-row').filter({ hasText: /^this\s*=/ });
  await application.waitFor();
  assert.match(await application.innerText(), /Joomla\\CMS\\Application\\AdministratorApplication/);
  await application.locator('.monaco-tl-twistie').click();
  await editor.locator('.debug-variables').getByText(/\(protected\)/).first().waitFor();
  await editor.locator('.monaco-editor [class*="debug-top-stack-frame"]').first().waitFor();
  assert.deepEqual(await page.evaluate(() => window.debugUiErrors), []);
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results', `debug-native-ui-${browserName}-${phpVersion}.png`) });
  const originalFrames = await page.evaluate(() => window.playground.debugger.stackTrace());
  const originalPath = originalFrames[0].source.path;
  const marker = '// JoomEngine paused buffer survives cross-file stepping';
  await editor.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(marker);
  await editor.locator('.tab.dirty').getByText('AdministratorApplication.php', { exact: true }).waitFor();
  let frames = originalFrames;
  for (let attempt = 0; frames[0].source.path === originalPath && attempt < 12; attempt++) {
    const before = await page.evaluate(() => window.debugEvents.filter(event => event.event === 'stopped').length);
    await editor.locator('.debug-toolbar .codicon-debug-step-into').click();
    await page.waitForFunction(count => window.debugEvents.filter(event => event.event === 'stopped').length > count, before);
    frames = await page.evaluate(() => window.playground.debugger.stackTrace());
  }
  assert.notEqual(frames[0].source.path, originalPath, 'Step Into must reach an unopened Joomla source file.');
  assert.ok(frames.length > originalFrames.length, 'The new file must be a real callee.');
  const calleePath = frames[0].source.path.slice('/persist/www'.length);
  const calleeName = calleePath.split('/').at(-1);
  await editor.locator('.tab.active').getByText(calleeName, { exact: true }).waitFor();
  await editor.locator('.monaco-editor [class*="debug-top-stack-frame"]').first().waitFor();
  await page.screenshot({ path: path.join(root, 'test-results', `debug-cross-file-${browserName}-${phpVersion}.png`) });
  await editor.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText(marker);
  await editor.locator('.tab.dirty').getByText(calleeName, { exact: true }).waitFor();
  await page.locator('button[data-i18n="code.saveAll"]').click();
  const pausedSources = await page.evaluate(async paths => Promise.all(paths.map(path => window.playground.workspace.request('read', { path })
    .then(value => new TextDecoder().decode(value.bytes)))), [originalPath.slice('/persist/www'.length), calleePath]);
  assert.ok(pausedSources.every(source => !source.includes(marker)), 'Queued saves cannot change the active PHP snapshot while paused.');
  assert.equal(await editor.locator('.tab.dirty').count(), 2, 'Both unsaved editor buffers must remain intact while saves wait.');
  let before = await page.evaluate(() => window.debugEvents.filter(event => event.event === 'stopped').length);
  await editor.locator('.debug-toolbar .codicon-debug-step-over').click();
  await page.waitForFunction(count => window.debugEvents.filter(event => event.event === 'stopped').length > count, before);
  frames = await page.evaluate(() => window.playground.debugger.stackTrace());
  assert.equal(frames[0].source.path, `/persist/www${calleePath}`, 'Step Over must retain the current callee source.');
  await editor.locator('.monaco-editor [class*="debug-top-stack-frame"]').first().waitFor();
  for (let attempt = 0; frames.length > originalFrames.length && attempt < 12; attempt++) {
    before = await page.evaluate(() => window.debugEvents.filter(event => event.event === 'stopped').length);
    await editor.locator('.debug-toolbar .codicon-debug-step-out').click();
    await page.waitForFunction(count => window.debugEvents.filter(event => event.event === 'stopped').length > count, before);
    frames = await page.evaluate(() => window.playground.debugger.stackTrace());
  }
  assert.equal(frames[0].source.path, originalPath);
  await editor.locator('.tab.active.dirty').getByText('AdministratorApplication.php', { exact: true }).waitFor();
  await editor.locator('.debug-toolbar .codicon-debug-continue').click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  assert.match(await response.text(), /JoomEngine Debug Contract/);
  await page.waitForFunction(() => window.playground.debugger.state === 'idle');
  await editor.locator('.debug-toolbar').waitFor({ state: 'hidden' });
  await editor.locator('.tab.dirty').first().waitFor({ state: 'hidden' });
  const savedSources = await page.evaluate(async paths => Promise.all(paths.map(path => window.playground.workspace.request('read', { path })
    .then(value => new TextDecoder().decode(value.bytes)))), [originalPath.slice('/persist/www'.length), calleePath]);
  assert.ok(savedSources.every(source => source.includes(marker)), 'Both dirty buffers must save only after PHP releases the request.');
  assert.deepEqual(await page.evaluate(() => window.debugUiErrors), []);
  await page.evaluate(() => window.codeHost.dispose());
  return { calleePath, dirtyBuffersPreserved: 2, pausedSaveQueued: true };
}

for (const name of browsers) for (const phpVersion of versions) test(
  `${name}: PHP ${phpVersion} debugs authenticated Joomla GET and POST once, then recovers after stop`,
  { timeout: 300_000 }, async () => {
    const server = await createStaticServer({ directory });
    const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
    const browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const page = await browser.newPage();
    const errors = [], logs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { logs.push(message.text()); if (process.env.PHPDBG_TRACE) console.error(message.text()); });
    page.setDefaultTimeout(120_000);
    try {
      await page.goto(`${server.url}__test__.html`);
      await page.evaluate(async ({ phpVersion, joomlaVersion }) => {
        const { createPlayground } = await import('./src/playground.mjs');
        window.debugEvents = [];
        window.playground = await createPlayground({ phpVersion, joomlaVersion, persistence: true, storageKey: `debug-contract-${crypto.randomUUID()}`,
          siteName: 'JoomEngine Debug Contract', initialPath: '/administrator/', autoLogin: true,
          admin: { username: 'jecdebug', name: 'Debug Administrator', email: 'debug@example.test', password: 'Debug-contract-password-123!' },
          extensions: [], startupCommands: [],
        }, { onProgress: event => console.log(`install: ${event.message || event.phase}`) });
        window.playground.debugger.subscribe(event => { window.debugEvents.push(event); console.log(JSON.stringify(event)); });
        const source = await window.playground.workspace.request('read', { path: '/libraries/src/Application/AdministratorApplication.php' });
        const text = new TextDecoder().decode(source.bytes);
        window.debugApplicationPath = '/persist/www/libraries/src/Application/AdministratorApplication.php';
        window.debugDispatchLine = text.split('\n').findIndex(line => line.trim() === '$this->dispatch();') + 1;
        if (window.debugDispatchLine < 1) throw new Error('The pinned Joomla administrator dispatch source was not found.');
        window.debugOriginalApplication = text;
        await window.playground.debugger.setBreakpoints(window.debugApplicationPath, [{ line: window.debugDispatchLine }]);
        await window.playground.debugger.start({ method: 'GET', url: new URL('administrator/index.php', window.playground.baseUrl).href });
        window.debugResponse = fetch(new URL('administrator/index.php', window.playground.baseUrl)).then(async response => {
          const result = { status: response.status, text: await response.text() };
          if (result.status >= 400) window.debugFailure = `${result.status}: ${result.text}`;
          return result;
        });
        window.debugResponse.catch(error => { window.debugFailure = error.message; });
      }, { phpVersion, joomlaVersion: manifest.defaults.joomlaVersion });
      await page.waitForFunction(() => window.playground.debugger.state === 'paused' || window.debugFailure);
      assert.equal(await page.evaluate(() => window.debugFailure), undefined);
      const inspected = await page.evaluate(async () => {
        const debug = window.playground.debugger;
        const frames = await debug.stackTrace();
        const scopes = await debug.scopes(frames[0].id);
        const variables = await debug.variables(scopes[0].variablesReference);
        const identity = await debug.evaluate('$this->getIdentity()->username', frames[0].id);
        const application = await debug.evaluate('$this', frames[0].id);
        const properties = await debug.variables(application.variablesReference, { start: 0, count: 5 });
        const callerScopes = await debug.scopes(frames[1].id);
        const caller = await debug.variables(callerScopes[0].variablesReference);
        await debug.setBreakpoints(window.debugApplicationPath, []);
        return { frames, variables, identity, properties, caller };
      });
      assert.ok(inspected.frames.length >= 2, JSON.stringify(inspected.frames));
      assert.equal(inspected.identity.result, '"jecdebug"');
      assert.ok(inspected.properties.length > 0);
      assert.ok(inspected.caller.length > 0);
      const stopCount = await page.evaluate(() => window.debugEvents.filter(event => event.event === 'stopped').length);
      await page.evaluate(() => window.playground.debugger.stepIn());
      await page.waitForFunction(count => window.debugEvents.filter(event => event.event === 'stopped').length > count, stopCount);
      const stepped = await page.evaluate(() => window.playground.debugger.stackTrace());
      assert.ok(stepped.length > inspected.frames.length, JSON.stringify(stepped));
      await page.evaluate(() => window.playground.debugger.continue());
      const response = await page.evaluate(() => window.debugResponse);
      assert.equal(response.status, 200, response.text.slice(0, 2000));
      assert.match(response.text, /JoomEngine Debug Contract/);
      assert.doesNotMatch(response.text, /id="mod-login-username"/);
      await page.evaluate(async () => {
        // Instrument the real administrator dispatch path for observable side
        // effects. The selected requests still boot and render actual Joomla.
        const probe = `
        $jecAction = $this->input->post->getCmd('jec_debug_action');
        if ($jecAction) {
            $jecDb = \\Joomla\\CMS\\Factory::getContainer()->get(\\Joomla\\Database\\DatabaseInterface::class);
            $jecDb->setQuery('CREATE TABLE IF NOT EXISTS #__jec_debug_once (id INT PRIMARY KEY AUTO_INCREMENT, action VARCHAR(16)) ENGINE=InnoDB')->execute();
            $jecDb->setQuery('INSERT INTO #__jec_debug_once (action) VALUES (' . $jecDb->quote($jecAction) . ')')->execute();
            $jecPath = '/persist/www/jec-debug-once.txt';
            file_put_contents($jecPath, (string) ((int) @file_get_contents($jecPath) + 1));
            $jecProbe = (object) ['username' => $this->getIdentity()->username, 'method' => $_SERVER['REQUEST_METHOD'], 'title' => $this->input->post->getString('title')];
            $jecTicks = 0;
            if ($jecAction === 'stop') { while (true) { $jecTicks++; } }
            header('X-Jec-Authenticated: ' . $jecProbe->username);
        }
`;
        const source = window.debugOriginalApplication.replace('        $this->dispatch();', `${probe}        $this->dispatch();`);
        await window.playground.workspace.request('write', { path: '/libraries/src/Application/AdministratorApplication.php',
          bytes: new TextEncoder().encode(source), overwrite: true });
        window.debugPostLine = source.split('\n').findIndex(line => line.trim() === '$jecTicks = 0;') + 1;
        await window.playground.debugger.setBreakpoints(window.debugApplicationPath, [{ line: window.debugPostLine }]);
        window.debugEvents = [];
        await window.playground.debugger.start({ method: 'POST', url: new URL('administrator/index.php', window.playground.baseUrl).href });
        window.debugResponse = fetch(new URL('administrator/index.php', window.playground.baseUrl), {
          method: 'POST', body: new URLSearchParams({ jec_debug_action: 'once', title: 'Real Joomla POST' }),
        }).then(async response => ({ status: response.status, headers: [...response.headers], text: await response.text() }));
      });
      await page.waitForFunction(() => window.playground.debugger.state === 'paused');
      const post = await page.evaluate(async () => {
        const debug = window.playground.debugger;
        const user = await debug.evaluate('$jecProbe->username');
        const method = await debug.evaluate('$jecProbe->method');
        const title = await debug.evaluate('$jecProbe->title');
        await debug.setBreakpoints(window.debugApplicationPath, []);
        window.debugQueuedSaved = false;
        window.debugQueuedSave = window.playground.workspace.request('write', {
          path: '/debug-queued.txt', bytes: new TextEncoder().encode('saved after paused request'),
        }).then(result => { window.debugQueuedSaved = true; return result; });
        return { user, method, title };
      });
      assert.equal(post.user.result, '"jecdebug"');
      assert.equal(post.method.result, '"POST"');
      assert.equal(post.title.result, '"Real Joomla POST"');
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.debugQueuedSaved), false, 'A paused execution keeps source writes queued.');
      await page.evaluate(() => window.playground.debugger.continue());
      const postResponse = await page.evaluate(() => window.debugResponse);
      assert.equal(postResponse.status, 200, postResponse.text.slice(0, 2000));
      assert.ok(postResponse.headers.some(([name, value]) => name === 'x-jec-authenticated' && value === 'jecdebug'));
      await page.evaluate(() => window.debugQueuedSave);
      const once = await page.evaluate(async () => {
        const result = await window.playground.runPhp(`<?php
require '/persist/www/configuration.php'; $config = new JConfig();
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
echo json_encode(['rows' => (int) $db->query('SELECT COUNT(*) FROM ' . $config->dbprefix . 'jec_debug_once')->fetchColumn(),
    'files' => (int) file_get_contents('/persist/www/jec-debug-once.txt'), 'queued' => file_get_contents('/persist/www/debug-queued.txt')]);`);
        return JSON.parse(result.text);
      });
      assert.deepEqual(once, { rows: 1, files: 1, queued: 'saved after paused request' });
      await page.evaluate(async () => {
        window.debugEvents = [];
        await window.playground.debugger.start({ method: 'POST', url: new URL('administrator/index.php', window.playground.baseUrl).href });
        window.debugResponse = fetch(new URL('administrator/index.php', window.playground.baseUrl), {
          method: 'POST', body: new URLSearchParams({ jec_debug_action: 'stop', title: 'Stopped Joomla POST' }),
        }).then(async response => ({ status: response.status, text: await response.text() }));
      });
      await page.waitForFunction(() => window.playground.debugger.state === 'running');
      // Let native Joomla reach the loop, then pause through the independent
      // control channel while its original HTTP request remains pending.
      await page.waitForTimeout(500);
      await page.evaluate(() => window.playground.debugger.pause());
      await page.waitForFunction(() => window.playground.debugger.state === 'paused');
      await page.evaluate(() => window.playground.debugger.stop());
      const stopped = await page.evaluate(() => window.debugResponse);
      assert.equal(stopped.status, 503);
      assert.match(stopped.text, /stopped.*not replayed/i);
      const recovered = await page.evaluate(async () => {
        const response = await fetch(new URL('administrator/index.php', window.playground.baseUrl));
        const result = await window.playground.runPhp(`<?php
require '/persist/www/configuration.php'; $config = new JConfig();
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
echo json_encode(['rows' => (int) $db->query('SELECT COUNT(*) FROM ' . $config->dbprefix . 'jec_debug_once')->fetchColumn(),
    'files' => (int) file_get_contents('/persist/www/jec-debug-once.txt')]);`);
        return { status: response.status, text: await response.text(), effects: JSON.parse(result.text), state: window.playground.debugger.state };
      });
      assert.equal(recovered.status, 200);
      assert.match(recovered.text, /JoomEngine Debug Contract/);
      assert.doesNotMatch(recovered.text, /id="mod-login-username"/);
      assert.deepEqual(recovered.effects, { rows: 2, files: 2 }, 'Stopped POST is never automatically replayed.');
      assert.equal(recovered.state, 'idle');
      const nativeSourceProof = phpVersion === manifest.defaults.phpVersion ? await assertNativeDebugWorkbench(page, name, phpVersion) : null;
      assert.deepEqual(errors, []);
      assert.doesNotMatch(logs.join('\n'), /(?:TypeError|RuntimeError):/, 'The native debug UI must render without JavaScript or WebAssembly errors.');
      await mkdir(path.join(root, 'test-results'), { recursive: true });
      await writeFile(path.join(root, 'test-results', `debug-joomla-${name}-${phpVersion}.json`), JSON.stringify({
        ok: true, browser: name, phpVersion, joomlaVersion: manifest.defaults.joomlaVersion,
        authenticatedGet: true, appObjectAndCaller: true, stepped: true, postOnce: once.rows === 1,
        pausedWriteQueued: true, stopAndRecovery: true, databaseEffects: recovered.effects.rows, filesystemEffects: recovered.effects.files,
        nativeWorkbenchDebugUI: phpVersion === manifest.defaults.phpVersion,
        nativeSourceProof,
      }, null, 2));
    } catch (error) {
      await mkdir(path.join(root, 'test-results'), { recursive: true });
      const state = await page.evaluate(() => ({ state: window.playground?.debugger.state, events: window.debugEvents?.slice(-50), failure: window.debugFailure })).catch(() => ({}));
      await writeFile(path.join(root, 'test-results', `debug-joomla-${name}-${phpVersion}.json`), JSON.stringify({ error: error.stack, errors, logs: logs.slice(-100), state }, null, 2));
      await page.screenshot({ path: path.join(root, 'test-results', `debug-joomla-failure-${name}-${phpVersion}.png`) }).catch(() => {});
      throw error;
    } finally {
      await page.evaluate(async () => { await window.playground?.debugger.stop(); await window.codeHost?.dispose(); await window.playground?.close(); }).catch(() => {});
      await browser.close(); await server.close();
    }
  },
);
