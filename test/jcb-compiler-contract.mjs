import assert from 'node:assert/strict';

/** Component selection loads details and applies its preferred Joomla version asynchronously. */
export async function selectJcbCompilerComponent(page, frame, { joomlaVersion, timeoutMs = 30_000 } = {}) {
  const major = String(joomlaVersion ?? await page.evaluate(() => window.playground.configuration.joomlaVersion)).split('.')[0];
  assert.match(major, /^[56]$/);
  const label = `Demo J${major}`;
  const id = await frame.locator('#component_id').evaluate((select, label) =>
    [...select.options].find(option => option.label.trim() === label)?.value, label);
  assert.ok(id, `The installed JCB must include ${label}.`);
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === new URL(frame.url()).origin
      && url.searchParams.get('option') === 'com_componentbuilder'
      && url.searchParams.get('task') === 'ajax.getComponentDetails'
      && url.searchParams.get('id') === id;
  }, { timeout: timeoutMs });
  const [response] = await Promise.all([pending, frame.locator('#component_id').selectOption(id)]);
  assert.equal(response.status(), 200, 'The selected component details must load before compilation.');
  const details = await response.json();
  assert.equal(details.error, undefined, details.error);
  assert.ok(typeof details.html === 'string' && details.html.length > 0);
  assert.equal(String(details.preferred_joomla_version), major);
  await frame.waitForFunction(({ id, version }) => {
    const applied = [...document.querySelectorAll('#component-details a[href]')].some(link => {
      const url = new URL(link.href);
      return url.searchParams.get('task') === 'joomla_component.edit' && url.searchParams.get('id') === id;
    });
    return applied && document.querySelector('#joomla_version')?.value === version;
  }, { id, version: String(details.preferred_joomla_version) }, { timeout: timeoutMs });
}

/** Exercise the real compiler form and its downloadable, independently readable package. */
export async function assertJcbCompiler(page, { navigationTimeoutMs = 90_000, compileTimeoutMs = 180_000 } = {}) {
  const { site, joomlaVersion, phpVersion, maxExecutionTime } = await page.evaluate(async () => {
    const result = await window.playground.runPhp('<?php echo ini_get("max_execution_time");');
    if (result.status !== 200) throw new Error(result.text);
    return { site: window.playground.baseUrl, joomlaVersion: window.playground.configuration.joomlaVersion,
      phpVersion: window.playground.configuration.phpVersion, maxExecutionTime: Number(result.text) };
  });
  assert.equal(maxExecutionTime, 60, 'The compiler must work with the shipping JCB execution limit.');
  const major = joomlaVersion.split('.')[0];
  const demo = `Demo J${major}`;
  let element = await page.locator('#site-frame').count() ? await page.locator('#site-frame').elementHandle() : null;
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
  let completed = false;
  try {
    page.testStep = `open the actual JCB compiler and choose ${demo}`;
    const response = await frame.goto(new URL('administrator/index.php?option=com_componentbuilder&view=compiler', site).href,
      { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    assert.equal(response.status(), 200);
    await frame.waitForFunction(() => {
      const image = document.querySelector('#compiler-spinner img');
      return image?.complete && image.naturalWidth > 0;
    }, null, { timeout: Math.min(navigationTimeoutMs, 30_000) });
    await selectJcbCompilerComponent(page, frame, { joomlaVersion });
    const started = Date.now();
    page.testStep = `compile ${demo} through the administrator form`;
    const [compiled] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: compileTimeoutMs }),
      frame.getByRole('button', { name: /Compile Component$/ }).click({ noWaitAfter: true }),
    ]);
    assert.equal(compiled.status(), 200, (await frame.locator('body').innerText()).slice(0, 3000));
    assert.doesNotMatch(await frame.locator('body').innerText(), /Undefined constant|Fatal error|Maximum execution time|SQLSTATE/);
    const link = await frame.getByRole('link', { name: /Download Component$/ }).getAttribute('href');
    const url = new URL(link, site);
    assert.equal(url.origin, new URL(site).origin);
    assert.ok(url.pathname.startsWith(new URL(site).pathname));
    const filename = url.pathname.split('/').at(-1);
    assert.match(filename, /^com_demo_[a-zA-Z0-9_]+\.zip$/);
    assert.ok(filename.endsWith(`__J${major}.zip`), 'The compiler must target the selected Joomla major version.');
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
    completed = true;
    return { demo, joomlaVersion, phpVersion, maxExecutionTime, compilerImage: true,
      durationMs: Date.now() - started, zipBytes: downloaded.length, entries: proof.entries,
      manifest: proof.manifest, download: true };
  } finally {
    // Preserve a failed form for the browser runner's diagnostic screenshot and HTML.
    if (completed && owned) await page.locator('#compiler-contract-frame').evaluate(element => element.remove());
    else if (completed && initial.startsWith(site)) await frame.goto(initial, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  }
}
