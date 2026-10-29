import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, firefox } from 'playwright';
import { stageCodeAssets } from '../scripts/code-assets.mjs';
import { createStaticServer } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const browserNames = (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',');

test('bundled JoomEngine Code preserves native document models through edits and detachment', { timeout: 120000 }, async () => {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.cache/code-browser-'));
  let server;
  try {
    await stageCodeAssets({ root, assets: path.join(directory, 'assets') });
    server = await createStaticServer({ directory });
    for (const name of browserNames) {
      assert.ok({ chromium, firefox }[name], `Unsupported browser ${name}`);
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      const browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${server.url}__test__.html`);
        await page.evaluate(async () => {
          const frame = document.createElement('iframe');
          frame.style.cssText = 'width:100%;height:740px;border:0';
          frame.src = './assets/code/editor.html';
          const loaded = new Promise(resolve => { frame.onload = resolve; });
          document.body.replaceChildren(frame);
          await loaded;
          const encoder = new TextEncoder();
          const decoder = new TextDecoder();
          const files = new Map([['/index.php', '<?php\necho "JoomEngine";\n'], ['/second.php', '<?php\n// second file\n']]);
          window.codeWrites = [];
          const revision = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
          const workspace = {
            withBatch: async callback => callback(workspace),
            async request(operation, args) {
              if (operation === 'stat') return args.path === '/' ? { type: 'directory', size: 0, mtime: 1, ctime: 1 }
                : files.has(args.path) ? { type: 'file', size: encoder.encode(files.get(args.path)).length, mtime: 1, ctime: 1 } : null;
              if (operation === 'list') return [...files].map(([path, text]) => ({ name: path.slice(1), path, type: 'file', size: text.length, mtime: 1, ctime: 1 }));
              if (operation === 'read') { const bytes = encoder.encode(files.get(args.path)); return { path: args.path, bytes, revision: await revision(bytes) }; }
              if (operation === 'write') {
                const bytes = new Uint8Array(args.bytes);
                files.set(args.path, decoder.decode(bytes));
                window.codeWrites.push({ path: args.path, text: files.get(args.path) });
                return { ok: true, changes: [{ type: 'changed', path: args.path }], results: [{ operation, path: args.path, revision: await revision(bytes) }] };
              }
              if (operation === 'search') return { results: [], cursor: null, truncated: false, skipped: 0 };
              throw Error(`Unexpected fixture operation ${operation}`);
            },
          };
          window.codeMountOptions = { workspace, siteId: 'browser-smoke', storageId: 'persisted-browser-smoke' };
          window.code = await frame.contentWindow.JoomEngineCode.mount(window.codeMountOptions);
          await window.code.openFile('/index.php');
          await window.code.command('type', { text: '// draft-one\n' });
          await window.code.openFile('/second.php');
          await window.code.command('type', { text: '// draft-two\n' });
        });
        assert.equal(await page.evaluate(() => window.code.getDirtyCount()), 2);
        assert.equal(await page.evaluate(() => window.codeWrites.length), 0);
        const popupPromise = page.waitForEvent('popup');
        await page.evaluate(() => window.code.detach());
        const popup = await popupPromise;
        assert.equal(await page.evaluate(() => window.code.getDirtyCount()), 2);
        await popup.close();
        await page.waitForFunction(() => window.code.getOpenFiles().length === 2);
        assert.equal(await page.evaluate(() => window.code.getDirtyCount()), 2);
        const saved = await page.evaluate(() => window.code.saveAll());
        assert.equal(saved.success, true);
        assert.equal(await page.evaluate(() => window.code.getDirtyCount()), 0);
        const writes = await page.evaluate(() => window.codeWrites);
        assert.equal(writes.length, 2);
        assert.ok(writes.some(write => write.path === '/index.php' && write.text.includes('draft-one')));
        assert.ok(writes.some(write => write.path === '/second.php' && write.text.includes('draft-two')));
        await page.evaluate(() => window.code.openFile('/index.php'));
        await page.evaluate(() => window.code.command('undo'));
        assert.equal(await page.evaluate(() => window.code.getDirtyCount()), 1, 'Undo history survives auxiliary-window closure');
        const drafts = await page.evaluate(() => window.code.getOpenFiles());
        await page.evaluate(async () => {
          await window.code.flushDrafts();
          await window.code.dispose();
          const old = document.querySelector('iframe');
          const frame = old.cloneNode();
          const loaded = new Promise(resolve => { frame.onload = resolve; });
          old.replaceWith(frame);
          await loaded;
          window.code = await frame.contentWindow.JoomEngineCode.mount(window.codeMountOptions);
        });
        assert.deepEqual(await page.evaluate(() => window.code.getOpenFiles()), drafts, 'Persisted site restores unsaved drafts into its new view');
        assert.deepEqual(errors, [], `${name} should mount and use the actual workbench without uncaught errors`);
      } finally { await browser.close(); }
    }
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});
