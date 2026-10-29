import assert from 'node:assert/strict';

/** Exercise the real compiler form and its downloadable, independently readable package. */
export async function assertJcbCompiler(page) {
  const site = await page.evaluate(() => window.playground.baseUrl);
  let element = await page.locator('#site-frame').elementHandle();
  const owned = !element;
  if (owned) {
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.id = 'compiler-contract-frame';
      frame.style.cssText = 'width:100%;height:1000px;border:0';
      document.body.append(frame);
    });
    element = await page.locator('#compiler-contract-frame').elementHandle();
  }
  const frame = await element.contentFrame();
  const initial = frame.url();
  try {
    page.testStep = 'open the actual JCB compiler and choose Demo J6';
    const response = await frame.goto(new URL('administrator/index.php?option=com_componentbuilder&view=compiler', site).href,
      { waitUntil: 'load', timeout: 90_000 });
    assert.equal(response.status(), 200);
    await frame.locator('#component_id').selectOption({ label: 'Demo J6' });
    const started = Date.now();
    page.testStep = 'compile Demo J6 through the administrator form';
    const [compiled] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'load', timeout: 180_000 }),
      frame.getByRole('button', { name: 'Compile Component', exact: true }).click(),
    ]);
    assert.equal(compiled.status(), 200, (await frame.locator('body').innerText()).slice(0, 3000));
    assert.doesNotMatch(await frame.locator('body').innerText(), /Undefined constant|Fatal error|Maximum execution time|SQLSTATE/);
    const link = await frame.getByRole('link', { name: 'Download Component', exact: true }).getAttribute('href');
    const url = new URL(link, site);
    assert.equal(url.origin, new URL(site).origin);
    assert.ok(url.pathname.startsWith(new URL(site).pathname));
    const filename = url.pathname.split('/').at(-1);
    assert.match(filename, /^com_demo_[a-zA-Z0-9_]+\.zip$/);
    const relative = url.pathname.slice(new URL(site).pathname.length);
    const downloaded = await page.evaluate(async path => {
      const response = await window.playground.request(path);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      return { status: response.status, length: bytes.length, signature: [...bytes.slice(0, 4)], hash };
    }, relative);
    assert.equal(downloaded.status, 200);
    assert.ok(downloaded.length > 1000, 'The compiler must produce a real nonempty installation package.');
    assert.deepEqual(downloaded.signature, [80, 75, 3, 4]);
    const proof = await page.evaluate(async filename => {
      const source = `<?php
        $file = '/persist/www/tmp/' . '${filename}';
        $zip = new ZipArchive();
        if ($zip->open($file) !== true) throw new RuntimeException('Cannot open the compiled component.');
        $manifest = null;
        for ($i = 0; $i < $zip->numFiles; $i++) {
          $name = $zip->getNameIndex($i);
          if (preg_match('~(^|/)demo\\.xml$~', $name)) {
            $xml = simplexml_load_string($zip->getFromIndex($i));
            $manifest = ['type' => (string) $xml['type'], 'name' => (string) $xml->name, 'version' => (string) $xml->version];
          }
        }
        echo json_encode(['hash' => hash_file('sha256', $file), 'entries' => $zip->numFiles, 'manifest' => $manifest], JSON_THROW_ON_ERROR);
        $zip->close();`;
      const result = await window.playground.runPhp(source);
      if (result.status !== 200) throw new Error(result.text);
      return JSON.parse(result.text);
    }, filename);
    assert.equal(proof.hash, downloaded.hash, 'The download must contain the exact compiled bytes.');
    assert.ok(proof.entries > 20);
    assert.equal(proof.manifest?.type, 'component');
    assert.match(proof.manifest.name, /demo/i);
    assert.ok(proof.manifest.version);
    return { demoJ6: true, durationMs: Date.now() - started, zipBytes: downloaded.length, entries: proof.entries,
      manifest: proof.manifest, download: true };
  } finally {
    if (owned) await page.locator('#compiler-contract-frame').evaluate(element => element.remove());
    else if (initial.startsWith(site)) await frame.goto(initial, { waitUntil: 'load', timeout: 90_000 });
  }
}
