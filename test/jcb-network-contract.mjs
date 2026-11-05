import assert from 'node:assert/strict';
import { createStaticServer } from './server.mjs';

export const powerGuid = '7d95ce74-53dc-4672-bd8a-3b71cdacabea';
export const fieldGuid = '75e830a6-a3a5-4327-9161-3f774a6f1591';
export const textFieldtypeGuid = '201327fe-3067-4316-a155-3fe2a52e05c0';
const apiBase = 'https://api.joomlacomponentbuilder.com/v1/network/';
const targets = ['super-powers', 'joomla-powers', 'packages'];

/** HTTP 200 alone is insufficient: validate the actual discovery document. */
export function assertNetworkApiProof(proof) {
  const expected = ['', ...targets.map(target => `community/jcb/${target}`)];
  assert.equal(proof.length, expected.length * 2);
  const seen = new Set();
  return proof.map(item => {
    assert.ok(['curl', 'stream'].includes(item.transport));
    const suffix = item.url.slice(apiBase.length);
    assert.ok(item.url.startsWith(apiBase) && expected.includes(suffix));
    const key = `${item.transport}:${suffix}`;
    assert.ok(!seen.has(key), 'Every transport must test each discovery endpoint exactly once.');
    seen.add(key);
    assert.equal(item.status, 200, `${key}: ${item.error || 'Discovery did not return HTTP 200.'}`);
    assert.equal(item.error, '');
    if (item.transport === 'curl') assert.equal(item.errno, 0);
    assert.equal(typeof item.body, 'string');
    const data = JSON.parse(item.body);
    let documents;
    if (suffix === '') {
      assert.ok(Array.isArray(data?.systems) && data.systems.length > 0, 'The root API must contain systems.');
      const projects = data.systems.flatMap(system => {
        assert.ok(Array.isArray(system.projects));
        return system.projects;
      });
      const project = projects.find(project => project.project === 'jcb');
      assert.ok(Array.isArray(project?.targets), 'The root API must advertise JCB targets.');
      documents = targets.map(target => project.targets.find(document => document.target === target));
    } else {
      assert.equal(data?.target, suffix.split('/').at(-1));
      documents = [data];
    }
    const networks = documents.map(document => {
      assert.ok(document && targets.includes(document.target));
      assert.ok(Array.isArray(document.network) && document.network.length > 0, 'Discovery must contain repository locations.');
      const mirrors = document.network.map(entry => {
        assert.ok([0, 1].includes(entry.status), 'Mirror health must be explicit.');
        const url = new URL(entry.url);
        assert.equal(url.protocol, 'https:');
        assert.equal(url.username + url.password + url.search + url.hash, '');
        assert.ok(url.hostname && url.pathname.endsWith(`/${document.target}`));
        return { url: url.href, status: entry.status };
      });
      return { target: document.target, mirrors };
    });
    return { transport: item.transport, url: item.url, status: item.status, networks };
  });
}

export function assertPowerClientProof(proof) {
  assert.equal(proof.before, 0, 'The read-only probe must start without the required Power.');
  assert.equal(proof.after, 0, 'The probe must not seed the compiler dependency.');
  assert.equal(proof.guid, powerGuid);
  assert.equal(proof.name, 'Actions');
  assert.ok(proof.sourceBytes > 100 && proof.hasGetMethod, 'JCB must retrieve the actual Power source.');
  assert.match(proof.sourceSha256, /^[a-f0-9]{64}$/);
}

export function assertEntityImportProof(proof) {
  assert.equal(proof.before, null, 'An existing field cannot prove a remote entity import.');
  assert.equal(proof.imported, true, 'JCB Remote.Get must report a completed import.');
  assert.equal(proof.count, 1);
  assert.equal(proof.after?.guid, fieldGuid);
  assert.equal(proof.after?.name, 'Greeting');
  assert.equal(proof.after?.fieldtype, textFieldtypeGuid);
  assert.equal(proof.after?.datatype, 'VARCHAR');
  assert.equal(String(proof.after?.datalenght), '255');
  const xml = proof.after?.xmlAttributes;
  assert.equal(xml?.name, 'greeting');
  assert.equal(xml?.label, 'Greeting');
  assert.equal(xml?.default, 'Some text');
  assert.equal(xml?.filter, 'STRING');
  assert.ok(Array.isArray(proof.repositories) && proof.repositories.length > 0, 'The import must identify its loaded remote index.');
  assert.ok(proof.repositories.some(repository => repository.repository === 'packages'
    && repository.branch === 'master' && repository.entry?.guid === fieldGuid));
}

/** Reuse the shipped Joomla bootstrap and its framed PHP error handling. */
export async function phpProbe(page, source) {
  return page.evaluate(async source => {
    const { parseProvisioningResult } = await import('./src/joomla/index.mjs');
    const response = await fetch('./src/joomla/php/common.php');
    if (!response.ok) throw new Error(`Cannot load the shipped PHP helpers: ${response.status}`);
    const common = await response.text();
    const program = `${common}\ntry {\n${source}\nplaygroundFinish(['ok'=>true, 'proof'=>$proof]);\n}`
      + ` catch (\\Throwable $error) { playgroundFinish(['ok'=>false, 'error'=>get_class($error) . ': ' . $error->getMessage()]); }`;
    const result = await window.playground.runPhp(program);
    return (await parseProvisioningResult(result)).proof;
  }, source);
}

function transportProgram(urls) {
  const encoded = Buffer.from(JSON.stringify(urls)).toString('base64');
  return String.raw`
    $proof = [];
    foreach (json_decode(base64_decode('${encoded}'), true, 512, JSON_THROW_ON_ERROR) as $url) {
      $curl = curl_init($url);
      curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>30,
        CURLOPT_HTTPHEADER=>['Content-Type: application/json']]);
      $body = curl_exec($curl);
      $proof[] = ['transport'=>'curl', 'url'=>$url, 'status'=>curl_getinfo($curl, CURLINFO_RESPONSE_CODE),
        'body'=>$body, 'errno'=>curl_errno($curl), 'error'=>curl_error($curl)];
      curl_close($curl);
      unset($http_response_header);
      error_clear_last();
      $context = stream_context_create(['http'=>['method'=>'GET', 'timeout'=>30, 'ignore_errors'=>true,
        'header'=>"Content-Type: application/json\r\n"]]);
      $body = @file_get_contents($url, false, $context);
      $status = 0;
      foreach ($http_response_header ?? [] as $header) {
        if (preg_match('~^HTTP/\S+\s+(\d+)~', $header, $match)) $status = (int) $match[1];
      }
      $proof[] = ['transport'=>'stream', 'url'=>$url, 'status'=>$status, 'body'=>$body,
        'error'=>$body === false ? (error_get_last()['message'] ?? 'HTTP stream failed') : ''];
    }`;
}

export async function assertLiveNetworkApi(page) {
  return assertNetworkApiProof(await phpProbe(page,
    transportProgram([apiBase, ...targets.map(target => apiBase + `community/jcb/${target}`)])));
}

const bootstrapJcb = String.raw`
  [$app, $container, $db] = playgroundApplication('/persist/www', true);
  require_once JPATH_ADMINISTRATOR . '/components/com_componentbuilder/src/Helper/PowerloaderHelper.php';
  $app->getInput()->set('option', 'com_componentbuilder');
  \VDM\Joomla\Utilities\Component\Helper::setOption('com_componentbuilder');
`;

export async function assertLivePowerClient(page) {
  const proof = await phpProbe(page, bootstrapJcb + String.raw`
    $guid = '${powerGuid}';
    $sql = 'SELECT COUNT(*) FROM #__componentbuilder_power WHERE guid=' . $db->quote($guid);
    $db->setQuery($sql); $before = (int) $db->loadResult();
    $grep = \VDM\Joomla\Componentbuilder\Power\Factory::_('Power.Grep');
    $grep->setBranchField('read_branch');
    $power = $grep->get($guid, ['remote']);
    $db->setQuery($sql); $after = (int) $db->loadResult();
    $source = $power->main_class_code ?? '';
    $proof = ['before'=>$before, 'after'=>$after,
      'fixture'=>['target'=>'super-powers', 'repository'=>'joomla/super-powers', 'ref'=>'master'],
      'guid'=>$power->guid ?? null, 'name'=>$power->name ?? null,
      'sourceBytes'=>strlen($source), 'sourceSha256'=>hash('sha256', $source),
      'hasGetMethod'=>(bool) preg_match('~\bfunction\s+get\s*\(~', $source)];
  `);
  assertPowerClientProof(proof);
  return proof;
}

export async function assertLiveFieldImport(page) {
  const proof = await phpProbe(page, bootstrapJcb + String.raw`
    $guid = '${fieldGuid}';
    $sql = 'SELECT guid,name,fieldtype,datatype,datalenght,xml FROM #__componentbuilder_field WHERE guid=' . $db->quote($guid);
    $db->setQuery($sql); $before = $db->loadAssoc();
    if ($before !== null) throw new RuntimeException('The Greeting fixture already exists before the remote import.');
    $grep = \VDM\Joomla\Componentbuilder\Package\Factory::_('Field.Grep');
    $grep->setBranchField('read_branch');
    $imported = \VDM\Joomla\Componentbuilder\Package\Factory::_('Field.Remote.Get')->item($guid, ['remote']);
    $db->setQuery($sql); $after = $db->loadAssoc();
    $db->setQuery('SELECT COUNT(*) FROM #__componentbuilder_field WHERE guid=' . $db->quote($guid));
    $count = (int) $db->loadResult();
    $repositories = [];
    foreach ($grep->getPaths() ?? [] as $path) {
      $entry = $path->index['field']->{$guid} ?? null;
      if ($entry !== null) $repositories[] = ['base'=>$path->base ?? null, 'organisation'=>$path->organisation,
        'repository'=>$path->repository, 'branch'=>$path->read_branch ?? null, 'target'=>$path->target ?? null, 'entry'=>$entry];
    }
    if ($after !== null) {
      $xml = simplexml_load_string(json_decode($after['xml'], true, 512, JSON_THROW_ON_ERROR));
      if ($xml === false) throw new RuntimeException('The imported field XML is invalid.');
      $attributes = [];
      foreach ($xml->attributes() as $name=>$value) $attributes[(string) $name] = (string) $value;
      unset($after['xml']); $after['xmlAttributes'] = $attributes;
    }
    $proof = ['before'=>$before, 'imported'=>$imported, 'count'=>$count, 'after'=>$after,
      'fixture'=>['target'=>'packages', 'ref'=>'master', 'guid'=>$guid], 'repositories'=>$repositories];
  `);
  assertEntityImportProof(proof);
  return proof;
}

/** Controlled local HTTP responses exercise real browser CORS, never live mirror substitution. */
export async function createNetworkControls(directory, appURL) {
  const itemPath = `src/${powerGuid}`;
  const fixtures = {
    'allowed.json': JSON.stringify({ proof: 'allowed native PHP network request' }),
    'denied.json': JSON.stringify({ proof: 'this must remain unreadable' }),
    'discovery.json': JSON.stringify({ target: 'super-powers', network: [
      { status: 1, url: 'https://tildegit.org/joomla/super-powers' },
      { status: 0, url: 'https://codeberg.org/joomla/super-powers' },
    ] }),
    'index.json': JSON.stringify({ [powerGuid]: { guid: powerGuid, path: itemPath,
      settings: `${itemPath}/settings.json`, power: `${itemPath}/code.power` } }),
    'settings.json': JSON.stringify({ guid: powerGuid, name: 'Controlled fixture' }),
    'source.power': '<?php function controlled_network_fixture() { return true; }',
  };
  return createStaticServer({ directory, prefix: '/network-controls/', isolation: false,
    corsOrigin: new URL(appURL).origin, corsPaths: Object.keys(fixtures).filter(name => name !== 'denied.json'), fixtures });
}

export async function assertControlledFailures(page, controlsURL) {
  const native = await phpProbe(page, transportProgram(['allowed.json', 'denied.json'].map(name => new URL(name, controlsURL).href)));
  for (const transport of ['curl', 'stream']) {
    const allowed = native.find(item => item.transport === transport && item.url.endsWith('/allowed.json'));
    assert.equal(allowed.status, 200);
    assert.equal(allowed.error, '');
    assert.equal(JSON.parse(allowed.body).proof, 'allowed native PHP network request');
    const denied = native.find(item => item.transport === transport && item.url.endsWith('/denied.json'));
    assert.equal(denied.body, false, `${transport} must not read a response without CORS permission.`);
    assert.ok(denied.error.length > 0);
    if (transport === 'curl') assert.ok(denied.errno > 0);
  }
  const fallback = await page.evaluate(async ({ controlsURL, guid }) => {
    const { createJcbRepositoryFetch } = await import('./src/jcb-network.mjs');
    const index = 'https://tildegit.org/api/v1/repos/joomla/super-powers/raw/super-powers.json?ref=master';
    const calls = [];
    // Only this explicit control uses an address adapter. Every response below
    // comes from an actual second-origin HTTP server and normal browser Fetch.
    const adapter = blocked => async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      let fixture = 'denied.json';
      if (url.hostname === 'api.joomlacomponentbuilder.com') fixture = 'discovery.json';
      else if (!blocked && url.hostname === 'codeberg.org') {
        fixture = url.pathname.endsWith('/settings.json') ? 'settings.json'
          : url.pathname.endsWith('/code.power') ? 'source.power' : 'index.json';
      }
      calls.push({ url: url.href, fixture, blocked });
      return fetch(new URL(fixture, controlsURL), init);
    };
    const options = { attemptTimeoutMs: 3000, timeoutMs: 10000 };
    const fetchRepository = createJcbRepositoryFetch(adapter(false), options);
    const first = await fetchRepository(index, { headers: { 'Content-Type': 'application/json' } });
    const data = await first.json();
    const path = index.replace('super-powers.json', data[guid].settings);
    const settings = await (await fetchRepository(path)).json();
    const source = await (await fetchRepository(index.replace('super-powers.json', data[guid].power))).text();
    let exhausted;
    try { await createJcbRepositoryFetch(adapter(true), options)(index); }
    catch (error) { exhausted = { name: error.name, message: error.message }; }
    return { status: first.status, guid: settings.guid, source, exhausted, calls };
  }, { controlsURL, guid: powerGuid });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.guid, powerGuid);
  assert.match(fallback.source, /controlled_network_fixture/);
  assert.equal(fallback.exhausted?.name, 'TypeError');
  assert.match(fallback.exhausted.message, /repository could not be read from the browser/);
  assert.match(fallback.exhausted.message, /tildegit\.org/);
  assert.match(fallback.exhausted.message, /codeberg\.org/);
  const indexed = fallback.calls.filter(call => !call.blocked && /\/src\//.test(call.url));
  assert.equal(indexed.length, 2);
  assert.ok(indexed.every(call => new URL(call.url).hostname === 'codeberg.org'), 'Files must remain on the successful index mirror.');
  const health = await phpProbe(page, '$proof = ["answer"=>6 * 7, "curl"=>extension_loaded("curl")];');
  assert.deepEqual(health, { answer: 42, curl: true }, 'Expected network failures must leave PHP usable.');
  return { kind: 'controlled local HTTP / real browser CORS',
    native: native.map(({ body, ...item }) => ({ ...item, readable: body !== false })), fallback, health };
}
