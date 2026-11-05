import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { assertJcbPageAssets } from './jcb-compiler-contract.mjs';
import { createStaticServer } from './server.mjs';

function bounded(promise, label, timeoutMs = 5000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

/** Real font loading must finish before a compiler page can be left or removed. */
export async function assertJcbDocumentAssets(browser, { directory }) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'assets/manifest.json'), 'utf8'));
  const joomla = manifest.joomla.find(entry => entry.version.startsWith('5.'));
  assert.ok(joomla, 'The asset regression requires the shipping Joomla 5 archive.');
  const archive = await readFile(path.resolve(directory, 'assets', joomla.url));
  assert.equal(createHash('sha256').update(archive).digest('hex'), joomla.sha256);
  const fontPath = 'media/vendor/roboto-fontface/fonts/roboto/Roboto-Bold.woff2';
  const font = unzipSync(archive, { filter: entry => entry.name === fontPath })[fontPath];
  assert.ok(font?.length > 1000, 'Use the actual Joomla font that was cancelled in the compiler regression.');

  let releaseFont, requestedFont;
  const release = new Promise(resolve => { releaseFont = resolve; });
  const requested = new Promise(resolve => { requestedFont = resolve; });
  const html = stylesheet => '<!doctype html><html><head><meta charset="utf-8">'
    + `<link rel="stylesheet" href="${stylesheet}"></head><body><h1>Compiler page assets</h1></body></html>`;
  const css = source => `@font-face{font-family:JcbAssetsProbe;src:url("${source}") format("woff2");font-weight:700;font-display:block}`
    + 'h1{font-family:JcbAssetsProbe;font-weight:700;font-size:32px}';
  const server = await createStaticServer({ directory, prefix: '/jcb-document-assets/', fixtures: {
    'pending.html': html('pending.css'),
    'pending.css': css('delayed.woff2'),
    'delayed.woff2': async () => { requestedFont(); await release; return font; },
    'missing.html': html('missing.css'),
    'missing.css': css('absent-probe-font.woff2'),
    'restored.html': '<!doctype html><title>Restored document</title><p>Restored</p>',
  } });
  const context = await browser.newContext();
  const page = await context.newPage();
  const failures = [];
  page.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
  let waiting;
  try {
    await page.goto(new URL('__test__.html', server.url).href);
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'compiler-assets'; frame.style.cssText = 'width:100%;height:300px';
      document.body.append(frame);
    });
    const frame = await (await page.locator('#compiler-assets').elementHandle()).contentFrame();
    const pendingURL = new URL('pending.html', server.url).href;
    await frame.goto(pendingURL, { waitUntil: 'domcontentloaded', timeout: 5000 });
    let restored = false;
    waiting = assertJcbPageAssets(frame, { timeoutMs: 5000 }).then(async proof => {
      restored = true;
      await frame.goto(new URL('restored.html', server.url).href, { waitUntil: 'load', timeout: 5000 });
      return proof;
    });
    // Attach the rejection handler immediately; the assertion below still awaits
    // the original promise and propagates any real loading or validation failure.
    void waiting.catch(() => {});
    await bounded(requested, 'The delayed font request');
    const pending = await frame.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return { status: document.fonts.status, faces: [...document.fonts].map(face => face.status) };
    });
    assert.equal(restored, false, 'The test must not navigate away while the font response is withheld.');
    assert.equal(frame.url(), pendingURL);
    assert.equal(pending.status, 'loading');
    assert.ok(pending.faces.includes('loading'));
    releaseFont();
    const loaded = await bounded(waiting, 'Complete font loading before restoring the page');
    assert.ok(loaded.fonts.some(face => face.family === 'JcbAssetsProbe' && face.status === 'loaded'));
    assert.deepEqual(failures, [], 'Waiting for page assets must prevent navigation from cancelling the font.');

    await frame.goto(new URL('missing.html', server.url).href, { waitUntil: 'domcontentloaded', timeout: 5000 });
    await assert.rejects(assertJcbPageAssets(frame, { timeoutMs: 5000 }), /font/i,
      'A genuinely missing font must still fail the compiler asset contract.');
    const failedFaces = await frame.evaluate(() => [...document.fonts].map(face => ({ family: face.family, status: face.status })));
    assert.ok(failedFaces.some(face => face.family === 'JcbAssetsProbe' && face.status === 'error'));
    return { sourceArchive: joomla.url, archiveSha256: joomla.sha256, fontPath,
      fontSha256: createHash('sha256').update(font).digest('hex'), delayedFont: loaded,
      restoredOnlyAfterFontLoaded: true, missingFontRejected: true, failedFaces };
  } finally {
    releaseFont();
    await context.close();
    await waiting?.catch(() => {});
    await server.close();
  }
}
