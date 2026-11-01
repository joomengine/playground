import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createStaticServer } from './server.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const archive = Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
const replacement = Buffer.from([...archive, 9]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = bytes => ({ prebuiltDeploys: [{ id: 'jcb', joomlaVersion: '6.2.0', phpVersion: '8.4',
  url: `snapshots/${hash(bytes)}.zip`, sha256: hash(bytes), size: bytes.length }] });

for (const name of (process.env.PLAYGROUND_BROWSERS || 'chromium,firefox').split(',')) {
  test(`deployment images survive reload and replace an outdated server image (${name})`, { timeout: 60_000 }, async () => {
    const server = await createStaticServer({ directory, fixtures: {
      'image-cache-fixture.html': '<!doctype html><title>Image cache persistence</title>',
      [`assets/snapshots/${hash(archive)}.zip`]: archive,
      [`assets/snapshots/${hash(replacement)}.zip`]: replacement,
    } });
    let browser;
    try {
      const executablePath = process.env[`PLAYGROUND_${name.toUpperCase()}_EXECUTABLE`];
      browser = await { chromium, firefox }[name].launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
      const page = await browser.newPage();
      const downloads = [];
      page.on('request', request => { if (request.url().endsWith('.zip')) downloads.push(request.url()); });
      await page.goto(`${server.url}image-cache-fixture.html`);
      const load = async catalog => page.evaluate(async manifest => {
        const { deploymentImages } = await import('./src/deployment-images.mjs');
        const entry = deploymentImages.maintained({ deployId: 'jcb', joomlaVersion: '6.2.0' }, manifest);
        const image = await deploymentImages.getMaintained(entry);
        return { cached: image.cached, bytes: [...image.bytes], rows: await deploymentImages.list(manifest) };
      }, catalog);
      const first = await load(manifest(archive));
      assert.equal(first.cached, false);
      assert.equal(first.rows[0].available, true);
      assert.equal(downloads.length, 1);
      await page.reload();
      const resumed = await load(manifest(archive));
      assert.equal(resumed.cached, true);
      assert.deepEqual(resumed.bytes, [...archive]);
      assert.equal(downloads.length, 1, 'A page reload reuses IndexedDB bytes without downloading the ZIP again.');

      const outdated = await page.evaluate(async manifest => {
        const { deploymentImages } = await import('./src/deployment-images.mjs');
        return deploymentImages.list(manifest);
      }, manifest(replacement));
      assert.equal(outdated[0].available, false, 'The old image becomes unusable when the server hash changes.');
      const updated = await load(manifest(replacement));
      assert.equal(updated.cached, false);
      assert.deepEqual(updated.bytes, [...replacement]);
      assert.equal(downloads.length, 2);
      const removed = await page.evaluate(async () => {
        const { deploymentImages } = await import('./src/deployment-images.mjs');
        const records = await deploymentImages.list();
        await deploymentImages.remove(records[0].key);
        return deploymentImages.list();
      });
      assert.deepEqual(removed, []);
    } finally { await browser?.close(); await server.close(); }
  });
}
