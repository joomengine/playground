import assert from 'node:assert/strict';
import { probeSyntheticRedirect, startRedirectTrace, recordVerifiedRedirectDiagnostic } from './firefox-redirect-probe.mjs';

// These dependencies are absent from the pinned clean JCB images. The compiler
// must retrieve them from the real repository network for both Demo targets.
const requiredDemoPowers = Object.freeze({
  power: ['7d95ce74-53dc-4672-bd8a-3b71cdacabea'],
  joomla_power: [
    'ca5456e1-552c-45fb-bf4c-b751ba6e9fa1',
    'a87c432d-b5b4-428e-b7ff-14b51664c624',
    '193deb3e-0c3e-4610-8e55-450e463095b4',
    '46ba6c12-361e-4f7d-b6d9-70450e7cd7c2',
    'a6ee04f5-33c7-4a9b-aa6d-6a03f3715a88',
    '47ee1f2b-9902-4f26-a856-04930ac9ddc3',
    'f5a65880-6185-4f43-8d55-770616692a40',
  ],
});

export function assertJcbCompilerMessages(body) {
  assert.doesNotMatch(body, /Undefined constant|Fatal error|Maximum execution time|SQLSTATE/i);
  assert.doesNotMatch(body,
    /(?:Super|Joomla)\s+Power\s+repository\b[\s\S]{0,250}?gave the following error|Power\s+guid:\s*[a-f0-9-]+\s+(?:not found|could not be found)|Failed to (?:fetch|connect to)\b/i,
    'A downloadable ZIP must not conceal failed repository reads or missing Powers.');
}

export function assertDemoDependencies(proof) {
  assert.ok(proof.phpEntries > 0, 'The compiled package must contain inspectable PHP files.');
  assert.deepEqual(proof.unresolved, [], 'Every Super/Joomla Power placeholder must be resolved in the compiled PHP.');
  assert.ok(proof.actionsDefinitions.length > 0, 'The generated package must include the required Permitted Actions class.');
  for (const [type, guids] of Object.entries(requiredDemoPowers)) {
    assert.deepEqual([...proof.powers[type]].sort(), [...guids].sort(), `The compiler must acquire every required ${type} record.`);
  }
}

async function readDemoPowerRecords(page) {
  return page.evaluate(async encoded => {
    const source = String.raw`<?php
      require '/persist/www/configuration.php';
      $config = new JConfig();
      $db = new PDO('mysql:dbname=' . $config->db . ';charset=utf8mb4', $config->user, $config->password,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
      $required = json_decode(base64_decode('${encoded}'), true, 512, JSON_THROW_ON_ERROR);
      $found = [];
      foreach ($required as $type => $guids) {
        $table = str_replace(chr(96), chr(96) . chr(96), $config->dbprefix . 'componentbuilder_' . $type);
        $query = $db->prepare('SELECT guid FROM ' . chr(96) . $table . chr(96)
          . ' WHERE guid IN (' . implode(',', array_fill(0, count($guids), '?')) . ') ORDER BY guid');
        $query->execute($guids);
        $found[$type] = $query->fetchAll(PDO::FETCH_COLUMN);
      }
      echo json_encode($found, JSON_THROW_ON_ERROR);`;
    const result = await window.playground.runPhp(source);
    if (result.status !== 200) throw new Error(result.text);
    return JSON.parse(result.text);
  }, Buffer.from(JSON.stringify(requiredDemoPowers)).toString('base64'));
}

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

/** Retrieve real dependencies, compile, inspect, install and open the generated Demo. */
export async function assertJcbCompiler(page, { navigationTimeoutMs = 90_000, compileTimeoutMs = 180_000, installTimeoutMs = 180_000, redirectProbe } = {}) {
  const probe = redirectProbe ?? await probeSyntheticRedirect(page.context().browser());
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
    const before = await readDemoPowerRecords(page);
    for (const type of Object.keys(requiredDemoPowers)) {
      assert.deepEqual(before[type], [], `The clean Demo fixture must require remote ${type} retrieval; cached records would hide a network regression.`);
    }
    const started = Date.now();
    page.testStep = `compile ${demo} through the administrator form`;
    const from = page.consoleErrors?.length ?? 0;
    const traceFrom = await startRedirectTrace(page);
    const [compiled] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: compileTimeoutMs }),
      frame.getByRole('button', { name: /Compile Component$/ }).click({ noWaitAfter: true }),
    ]);
    const compilerBody = await frame.locator('body').innerText();
    assert.equal(compiled.status(), 200, compilerBody.slice(0, 3000));
    assertJcbCompilerMessages(compilerBody);
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
      const source = String.raw`<?php
        $file = '/persist/www/tmp/' . '${filename}';
        $zip = new ZipArchive();
        if ($zip->open($file) !== true) throw new RuntimeException('Cannot open the compiled component.');
        $manifest = null;
        $phpEntries = 0;
        $unresolved = [];
        $actionsDefinitions = [];
        for ($i = 0; $i < $zip->numFiles; $i++) {
          $name = $zip->getNameIndex($i);
          if (preg_match('~(^|/)demo\.xml$~', $name)) {
            $xml = simplexml_load_string($zip->getFromIndex($i));
            $manifest = ['type' => (string) $xml['type'], 'name' => (string) $xml->name, 'version' => (string) $xml->version];
          }
          if (str_ends_with($name, '.php')) {
            $phpEntries++;
            $contents = $zip->getFromIndex($i);
            if (preg_match_all('~(?:Super|Joomla)___[0-9a-f_-]+___Power~i', $contents, $matches)) {
              $unresolved[] = ['file' => $name, 'placeholders' => array_values(array_unique($matches[0]))];
            }
            if (preg_match('~\bclass\s+Actions\b~', $contents)
              && str_contains($contents, '\\Utilities\\Permitted')) $actionsDefinitions[] = $name;
          }
        }
        echo json_encode(['hash' => hash_file('sha256', $file), 'entries' => $zip->numFiles, 'manifest' => $manifest,
          'phpEntries' => $phpEntries, 'unresolved' => $unresolved, 'actionsDefinitions' => $actionsDefinitions], JSON_THROW_ON_ERROR);
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
    proof.powers = await readDemoPowerRecords(page);
    assertDemoDependencies(proof);
    const durationMs = Date.now() - started;
    if (page.consoleErrors) await recordVerifiedRedirectDiagnostic(page, {
      probe, kind: 'post303', from, traceFrom,
      sourceURL: new URL('service-worker.mjs', page.url()).href, step: page.testStep,
      finalURL: frame.url(), responseStatus: compiled.status(), methodAfterRedirect: compiled.request().method(),
    });
    page.testStep = `install the compiled ${demo} through JCB`;
    const installFrom = page.consoleErrors?.length ?? 0;
    const installTraceFrom = await startRedirectTrace(page);
    const [installed] = await Promise.all([
      frame.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: installTimeoutMs }),
      frame.getByRole('button', { name: /Install com_demo.*component/ }).click({ noWaitAfter: true }),
    ]);
    const installedBody = await frame.locator('body').innerText();
    assert.equal(installed.status(), 200, installedBody.slice(0, 3000));
    assertJcbCompilerMessages(installedBody);
    assert.match(installedBody, /Installation of the component was successful\./);
    if (page.consoleErrors) await recordVerifiedRedirectDiagnostic(page, {
      probe, kind: 'post303', from: installFrom, traceFrom: installTraceFrom,
      sourceURL: new URL('service-worker.mjs', page.url()).href, step: page.testStep,
      finalURL: frame.url(), responseStatus: installed.status(), methodAfterRedirect: installed.request().method(),
    });

    page.testStep = `open the installed ${demo} dashboard`;
    const dashboard = await frame.goto(new URL('administrator/index.php?option=com_demo', site).href,
      { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
    const dashboardBody = await frame.locator('body').innerText();
    assert.equal(dashboard.status(), 200, dashboardBody.slice(0, 3000));
    assert.doesNotMatch(dashboardBody, /Fatal error|Class .*not found|Call to undefined|(?:Super|Joomla)___[0-9a-f_-]+___Power|An error has occurred/i);
    assert.match(dashboardBody, /Demo Dashboard/);
    assert.equal(await frame.locator('input[name="passwd"]').count(), 0, 'The installed Demo must open in the authenticated administrator session.');
    completed = true;
    return { demo, joomlaVersion, phpVersion, maxExecutionTime, compilerImage: true,
      durationMs, zipBytes: downloaded.length, entries: proof.entries,
      manifest: proof.manifest, download: true, requiredPowers: proof.powers,
      actionsDefinitions: proof.actionsDefinitions, unresolvedPowers: proof.unresolved,
      installed: true, dashboard: true };
  } finally {
    // Preserve a failed form for the browser runner's diagnostic screenshot and HTML.
    if (completed && owned) await page.locator('#compiler-contract-frame').evaluate(element => element.remove());
    else if (completed && initial.startsWith(site)) await frame.goto(initial, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  }
}
