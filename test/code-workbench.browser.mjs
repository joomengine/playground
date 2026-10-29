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

// Allow the added native close/rename dialogs and view-state round trips while
// retaining the language, encoding, recovery and conflict checks in this suite.
test('bundled JoomEngine Code preserves native document models through edits and detachment', { timeout: 240000 * browserNames.length }, async () => {
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
        const expectedOperationErrors = new Set();
        page.on('pageerror', error => {
          // Native bulk-edit progress also reports its handled rejection through
          // the global error hook. Only deliberately exercised failures qualify.
          if (!expectedOperationErrors.has(error.message)) { errors.push(error.stack || error.message); console.error(error.stack || error.message); }
        });
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
          const files = new Map([['/index.php', '<?php\necho "JoomEngine";\n' + Array.from({ length: 160 }, (_, index) => `// line ${index + 1} native view continuity`).join('\n')], ['/second.php', '<?php\n// second file\n'], ['/script.js', 'const answer = "hello";\nanswer.'], ['/page.html', '<div cla'], ['/style.css', 'a { col }'], ['/data.json', '{"name": }'], ['/mixed.php', '<?php echo "hi"; ?><span cla'], ['/library.php', '<?php namespace Demo; class Factory { public static function getApplication() {} }'], ['/use.php', '<?php use Demo\\Factory; Factory::getApplication();'], ['/invalid.php', '<?php function broken( {'], ['/conflict.php', '<?php echo "original";'], ['/invalid-utf8.txt', ''], ['/utf16.txt', ''], ['/close-save.php', '<?php // original save'], ['/close-cancel.php', '<?php // original cancel'], ['/rename-source.php', '<?php // original rename']]);
          const rawFiles = new Map([['/invalid-utf8.txt', new Uint8Array([0xc3, 0x28])], ['/utf16.txt', new Uint8Array([0xff, 0xfe, 97, 0, 13, 0, 10, 0])]]);
          const bytesOf = path => rawFiles.get(path) || encoder.encode(files.get(path));
          window.changeFixtureFile = (path, text) => { files.set(path, text); rawFiles.delete(path); };
          window.renameFixtureFile = (from, to) => { files.set(to, files.get(from)); files.delete(from); if (rawFiles.has(from)) { rawFiles.set(to, rawFiles.get(from)); rawFiles.delete(from); } };
          window.codeWrites = [];
          window.codeMutations = [];
          window.fixtureRenameBlocked = true;
          const revision = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
          let batchDepth = 0;
          const workspace = {
            async withBatch(callback) { batchDepth++; try { return await callback(workspace); } finally { batchDepth--; } },
            async request(operation, args) {
              if (operation === 'stat') return args.path === '/' ? { type: 'directory', size: 0, mtime: 1, ctime: 1 }
                : files.has(args.path) ? { type: 'file', size: bytesOf(args.path).length, mtime: 1, ctime: 1, revision: await revision(bytesOf(args.path)) } : null;
              if (operation === 'list') return [...files].map(([path, text]) => ({ name: path.slice(1), path, type: 'file', size: text.length, mtime: 1, ctime: 1 }));
              if (operation === 'read') { const bytes = bytesOf(args.path); return { path: args.path, bytes, revision: await revision(bytes) }; }
              if (operation === 'write') {
                const current = files.has(args.path) ? await revision(bytesOf(args.path)) : null;
                if (args.expectedRevision !== undefined && args.expectedRevision !== current) { const error = new Error('File changed outside the editor'); error.code = 'CONFLICT'; throw error; }
                const bytes = new Uint8Array(args.bytes);
                rawFiles.set(args.path, bytes);
                files.set(args.path, decoder.decode(bytes));
                window.codeWrites.push({ path: args.path, text: files.get(args.path), bytes: [...bytes], batchDepth });
                return { ok: true, changes: [{ type: 'changed', path: args.path }], results: [{ operation, path: args.path, revision: await revision(bytes) }] };
              }
              if (operation === 'rename') {
                window.codeMutations.push({ operation, path: args.path, target: args.target });
                if (window.fixtureRenameBlocked) { const error = new Error('Fixture rename blocked'); error.code = 'READ_ONLY'; throw error; }
                window.renameFixtureFile(args.path, args.target);
                return { ok: true, results: [{ operation, path: args.path, target: args.target }], changes: [{ type: 'deleted', path: args.path }, { type: 'created', path: args.target }] };
              }
              if (operation === 'delete') { window.codeMutations.push({ operation, path: args.path }); files.delete(args.path); rawFiles.delete(args.path); return { ok: true, results: [{ operation, path: args.path }], changes: [{ type: 'deleted', path: args.path }] }; }
              if (operation === 'search') {
                const results = [];
                for (const [path, text] of files) {
                  if (args.kind === 'files') { results.push({ path }); continue; }
                  for (const [index, line] of text.split('\n').entries()) {
                    const column = line.indexOf(args.query);
                    if (column >= 0) results.push({ path, revision: await revision(encoder.encode(text)), lineNumber: index + 1,
                      column: column + 1, endColumn: column + args.query.length + 1, preview: line, previewColumn: column + 1 });
                  }
                }
                return { results, cursor: null, truncated: false, skipped: 0 };
              }
              throw Error(`Unexpected fixture operation ${operation}`);
            },
          };
          window.codeMountOptions = { workspace, siteId: 'browser-smoke', storageId: 'persisted-browser-smoke',
            debuggerBackend: { subscribe: () => () => {}, start: async () => {}, stop: async () => {}, setBreakpoints: async () => [],
              continue: async () => {}, next: async () => {}, stepIn: async () => {}, stepOut: async () => {}, pause: async () => {},
              stackTrace: async () => [], scopes: async () => [], variables: async () => [], evaluate: async () => ({ result: '' }) } };
          window.code = await frame.contentWindow.JoomEngineCode.mount(window.codeMountOptions);
          await window.code.openFile('/index.php');
          await window.code.command('type', { text: '// draft-one\n' });
          await window.code.openFile('/second.php');
          await window.code.command('type', { text: '// draft-two\n' });
        });
        assert.equal(await page.evaluate(() => window.code.getDirtyCount()), 2);
        assert.equal(await page.evaluate(() => window.codeWrites.length), 0);
        await page.evaluate(() => window.code.command('workbench.action.editorLayoutTwoColumns'));
        await page.evaluate(async () => {
          const pane = await window.code.openFile('/index.php');
          const control = pane.getControl();
          control.setSelection({ startLineNumber: 60, startColumn: 4, endLineNumber: 60, endColumn: 11 });
          control.setScrollTop(900, 1);
          window.readNativeView = async () => {
            const current = (await window.code.openFile('/index.php')).getControl();
            return { selection: { ...current.getSelection() }, scrollTop: current.getScrollTop(), scrollLeft: current.getScrollLeft(), value: current.getModel().getValue() };
          };
        });
        const viewBeforeMoving = await page.evaluate(() => window.readNativeView());
        assert.ok(viewBeforeMoving.scrollTop > 0 && viewBeforeMoving.selection.startLineNumber === 60);
        await page.evaluate(async () => {
          const frame = document.querySelector('iframe');
          frame.style.display = 'none';
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          frame.style.display = '';
          window.code.layout();
        });
        assert.deepEqual(await page.evaluate(() => window.readNativeView()), viewBeforeMoving, 'Hiding and reopening preserves native selection, scroll and draft');
        for (const style of ['position:fixed;left:40px;top:80px;width:840px;height:520px;border:0', 'width:100%;height:740px;border:0']) {
          await page.evaluate(async style => { document.querySelector('iframe').style.cssText = style; window.code.layout(); await new Promise(resolve => requestAnimationFrame(resolve)); }, style);
          assert.deepEqual(await page.evaluate(() => window.readNativeView()), viewBeforeMoving, 'Relocating and resizing the same view preserves native selection, scroll and draft');
        }
        const editorLayout = await page.evaluate(() => window.code.getEditorLayout());
        const editorGroups = await page.evaluate(() => window.code.getEditorGroups());
        assert.equal(editorLayout.groups.length, 2);
        const popupPromise = page.waitForEvent('popup');
        await page.evaluate(() => window.code.detach());
        const popup = await popupPromise;
        assert.deepEqual(await page.evaluate(() => window.code.getEditorLayout()), editorLayout, 'Detached groups preserve split layout');
        assert.deepEqual(await page.evaluate(() => window.code.getEditorGroups()), editorGroups, 'Detached groups preserve tab membership and ordering');
        assert.equal(await page.evaluate(() => window.code.getDirtyCount()), 2);
        assert.deepEqual(await page.evaluate(() => window.readNativeView()), viewBeforeMoving, 'Detachment retains the native selection, cursor and scroll position');
        await popup.getByRole('button', { name: 'index.php', exact: true }).click();
        const bounds = await popup.locator('.part.editor').boundingBox();
        assert.ok(bounds.x >= 180 && bounds.y >= 62, 'Native editor is laid out beside detached navigation');
        await popup.close();
        await page.waitForFunction(() => window.code.getOpenFiles().length === 2);
        assert.deepEqual(await page.evaluate(() => window.code.getEditorLayout()), editorLayout, 'Redocked groups preserve split layout');
        assert.deepEqual(await page.evaluate(() => window.readNativeView()), viewBeforeMoving, 'Redocking retains the native selection, cursor and scroll position');
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
        await page.evaluate(() => window.code.command('editor.debug.action.toggleBreakpoint'));
        await page.waitForFunction(() => window.code.getBreakpoints().length === 1);
        const breakpoints = await page.evaluate(() => window.code.getBreakpoints());
        assert.equal(breakpoints.length, 1);
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
        assert.deepEqual(await page.evaluate(() => window.code.getBreakpoints()), breakpoints, 'Source breakpoints survive view recovery');
        for (const [path, lineNumber, column, expected] of [
          ['/script.js', 2, 8, 'charAt'], ['/style.css', 1, 8, 'color'], ['/page.html', 1, 9, 'class'], ['/mixed.php', 1, 29, 'class'],
        ]) {
          await page.evaluate(path => window.code.openFile(path), path);
          let labels = [];
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            labels = await page.evaluate(async ({ path, lineNumber, column }) => {
              const result = await window.code.command('_executeCompletionItemProvider', window.code.provider.uri(path), { lineNumber, column });
              return result.suggestions.map(item => typeof item.label === 'string' ? item.label : item.label.label);
            }, { path, lineNumber, column });
            if (labels.includes(expected)) break;
            await page.waitForTimeout(100);
          }
          assert.ok(labels.includes(expected), `${path} native completion must contain ${expected}; got ${labels.slice(0, 20)}`);
        }
        await page.evaluate(() => window.code.openFile('/use.php'));
        await page.evaluate(() => window.code.command('joomengineCode.refreshPhpIndex'));
        const definitions = await page.evaluate(() => window.code.command('_executeDefinitionProvider', window.code.provider.uri('/use.php'), { lineNumber: 1, column: 37 }));
        assert.ok(definitions.some(value => (value.uri || value.targetUri)?.path === '/library.php'), 'Native PHP definition resolves a project class method');
        await page.evaluate(() => window.code.openFile('/invalid.php'));
        await page.waitForFunction(() => window.code.getDiagnostics('/invalid.php').length > 0);
        await page.evaluate(() => window.code.openFile('/data.json'));
        await page.waitForFunction(() => window.code.getDiagnostics('/data.json').length > 0, { timeout: 30000 });
        await page.evaluate(() => window.code.saveAll());
        await page.evaluate(() => window.code.command('workbench.action.findInFiles', { query: 'second file', replace: 'reviewed replacement', triggerSearch: true }));
        const codeFrame = page.frames().find(frame => frame.url().endsWith('/assets/code/editor.html'));
        await codeFrame.getByRole('button', { name: /Replace All/ }).click();
        await codeFrame.getByRole('button', { name: 'Replace', exact: true }).click();
        await page.waitForFunction(() => window.codeWrites.some(write => write.path === '/second.php' && write.text.includes('reviewed replacement')));
        assert.equal(await page.evaluate(() => window.codeWrites.find(write => write.text.includes('reviewed replacement')).batchDepth), 1, 'Native project replace reserves the owner queue across the accepted batch');
        await page.evaluate(async () => {
          await window.code.openFile('/conflict.php');
          await window.code.command('type', { text: '// local draft\n' });
          window.changeFixtureFile('/conflict.php', '<?php echo "external";');
        });
        const conflict = await page.evaluate(() => window.code.saveAll());
        assert.equal(conflict.success, false, 'External mutation must keep the local draft dirty');
        await page.evaluate(() => window.code.provider.readFile(window.code.provider.uri('/conflict.php')));
        const stillConflicted = await page.evaluate(() => window.code.saveAll());
        assert.equal(stillConflicted.success, false, 'Reading comparison bytes cannot authorize overwrite');
        await codeFrame.getByRole('button', { name: 'Overwrite', exact: true }).first().click();
        await page.waitForFunction(() => !window.code.isDirty('/conflict.php'));
        assert.ok(await page.evaluate(() => window.codeWrites.some(write => write.path === '/conflict.php' && write.text.includes('local draft') && write.text.includes('original'))), 'Explicit native Overwrite writes the reviewed local buffer');
        await page.evaluate(() => window.code.openFile('/invalid-utf8.txt'));
        assert.equal(await page.evaluate(() => window.code.getOpenFiles().find(file => file.path === '/invalid-utf8.txt')?.text), undefined, 'Invalid UTF8 has no editable replacement-character model');
        assert.ok(await codeFrame.getByText(/bytes that are not valid UTF-8/).count(), 'Unsupported decoding explains how to recover original bytes');
        await page.evaluate(() => window.code.openWithEncoding('/invalid-utf8.txt', 'windows1252'));
        assert.equal(await page.evaluate(() => window.code.getOpenFiles().find(file => file.path === '/invalid-utf8.txt')?.text), 'Ã(', 'An explicit supported legacy encoding can recover the original text');
        await page.evaluate(async () => { await window.code.openFile('/utf16.txt'); await window.code.command('type', { text: 'b' }); await window.code.saveAll(); });
        const utf16 = await page.evaluate(() => window.codeWrites.find(write => write.path === '/utf16.txt')?.bytes);
        assert.deepEqual(utf16, [0xff, 0xfe, 98, 0, 97, 0, 13, 0, 10, 0], 'UTF16 BOM and CRLF survive native editing and saving');
        const groupsBeforeRename = await page.evaluate(() => window.code.getEditorGroups());
        await page.evaluate(async () => {
          window.renameFixtureFile('/second.php', '/renamed.php');
          await window.code.reconcileApplied({ ok: true, recoveryId: 'rename-smoke', results: [{ operation: 'rename', path: '/second.php', target: '/renamed.php' }] });
        });
        assert.deepEqual(await page.evaluate(() => window.code.getEditorGroups()), groupsBeforeRename.map(group => ({ ...group,
          paths: group.paths.map(path => path === '/second.php' ? '/renamed.php' : path), activePath: group.activePath === '/second.php' ? '/renamed.php' : group.activePath })), 'Applied AI rename follows clean native tabs without changing their group/order');
        await page.evaluate(async () => {
          window.renameFixtureFile('/renamed.php', '/second.php');
          await window.code.reconcileApplied({ ok: true, recoveryId: 'rename-smoke', results: [{ operation: 'recover', path: '/second.php' }, { operation: 'recover', path: '/renamed.php' }] });
        });
        assert.deepEqual(await page.evaluate(() => window.code.getEditorGroups()), groupsBeforeRename, 'Successful recovery reverses tracked native-tab renames');
        await page.evaluate(async () => { await window.code.openFile('/close-cancel.php'); await window.code.command('type', { text: '// keep draft\n' }); });
        await page.evaluate(() => { window.pendingNativeClose = window.code.command('workbench.action.closeActiveEditor'); });
        await codeFrame.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.evaluate(() => window.pendingNativeClose);
        assert.equal(await page.evaluate(() => window.code.isDirty('/close-cancel.php')), true, 'Cancel keeps the native tab and its dirty buffer');
        assert.ok(await page.evaluate(() => window.code.getOpenFiles().find(file => file.path === '/close-cancel.php')?.text.includes('keep draft')));
        expectedOperationErrors.add('Save or discard the unsaved changes in /close-cancel.php before deleting this path.');
        await page.evaluate(async () => { await window.code.command('workbench.view.explorer'); await window.code.command('revealInExplorer', window.code.provider.uri('/close-cancel.php')); window.pendingDelete = window.code.command('deleteFile'); });
        await codeFrame.getByRole('button', { name: 'Delete', exact: true }).click();
        await codeFrame.getByText('Save or discard the unsaved changes in /close-cancel.php before deleting this path.', { exact: true }).waitFor();
        await codeFrame.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.evaluate(() => window.pendingDelete);
        assert.equal(await page.evaluate(() => window.code.isDirty('/close-cancel.php')), true, 'Rejected dirty deletion preserves the original dirty buffer');
        assert.equal(await page.evaluate(() => window.codeMutations.some(change => change.operation === 'delete')), false, 'Dirty deletion never reaches authoritative storage');
        await page.evaluate(async () => { await window.code.openFile('/close-cancel.php'); window.pendingNativeClose = window.code.command('workbench.action.closeActiveEditor'); });
        await codeFrame.getByRole('button', { name: "Don't Save", exact: true }).click();
        await page.evaluate(() => window.pendingNativeClose);
        assert.equal(await page.evaluate(() => window.code.getOpenFiles().some(file => file.path === '/close-cancel.php')), false, 'Discard closes the native tab');
        assert.equal(await page.evaluate(() => window.codeWrites.some(write => write.path === '/close-cancel.php')), false, 'Discard does not write its rejected draft');
        await page.evaluate(() => window.code.openFile('/close-cancel.php'));
        assert.equal(await page.evaluate(() => window.code.getOpenFiles().find(file => file.path === '/close-cancel.php')?.text), '<?php // original cancel');
        await page.evaluate(async () => { await window.code.openFile('/close-save.php'); await window.code.command('type', { text: '// accepted save\n' }); window.pendingNativeClose = window.code.command('workbench.action.closeActiveEditor'); });
        await codeFrame.getByRole('button', { name: 'Save', exact: true }).click();
        await page.evaluate(() => window.pendingNativeClose);
        assert.equal(await page.evaluate(() => window.code.getOpenFiles().some(file => file.path === '/close-save.php')), false, 'Save closes the native tab after writing');
        assert.ok(await page.evaluate(() => window.codeWrites.find(write => write.path === '/close-save.php')?.text.includes('accepted save')));
        expectedOperationErrors.add('Fixture rename blocked');
        await page.evaluate(async () => { await window.code.openFile('/rename-source.php'); await window.code.command('type', { text: '// rename draft\n' }); await window.code.command('revealInExplorer', window.code.provider.uri('/rename-source.php')); await window.code.command('renameFile'); });
        const renameInput = codeFrame.getByRole('textbox', { name: 'Type file name. Press Enter to confirm or Escape to cancel.', exact: true });
        await renameInput.fill('renamed-dirty.php'); await renameInput.press('Enter');
        await page.waitForFunction(() => window.codeMutations.some(change => change.operation === 'rename'));
        await codeFrame.getByText(/Fixture rename blocked/).first().waitFor();
        assert.equal(await page.evaluate(() => window.code.isDirty('/rename-source.php')), true, 'Failed native rename restores the dirty source state');
        assert.ok(await page.evaluate(() => window.code.getOpenFiles().find(file => file.path === '/rename-source.php')?.text.includes('rename draft')));
        await page.evaluate(async () => { window.fixtureRenameBlocked = false; await window.code.command('revealInExplorer', window.code.provider.uri('/rename-source.php')); await window.code.command('renameFile'); });
        await renameInput.fill('renamed-dirty.php'); await renameInput.press('Enter');
        await page.waitForFunction(() => window.code.getOpenFiles().some(file => file.path === '/renamed-dirty.php' && file.dirty && file.text.includes('rename draft')));
        assert.equal(await page.evaluate(() => window.code.getOpenFiles().some(file => file.path === '/rename-source.php')), false, 'Successful native rename updates the dirty document identity');
        await page.evaluate(() => window.code.saveAll());
        assert.ok(await page.evaluate(() => window.codeWrites.some(write => write.path === '/renamed-dirty.php' && write.text.includes('rename draft'))), 'The renamed dirty buffer saves under its new path');
        for (const query of ['terminal', 'remote-ssh']) {
          await page.evaluate(() => window.code.command('workbench.action.showCommands'));
          await codeFrame.locator('.quick-input-box input').fill(`>${query}`);
          await codeFrame.getByText('No matching commands', { exact: true }).waitFor();
          await codeFrame.locator('.quick-input-box input').press('Escape');
        }
        assert.deepEqual(errors, [], `${name} should mount and use the actual workbench without uncaught errors`);
      } finally { await browser.close(); }
    }
  } finally { await server?.close(); await rm(directory, { recursive: true, force: true }); }
});
