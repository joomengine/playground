import assert from 'node:assert/strict';

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
  assert.equal(proof.defaultProbe.after, null, 'The default read-only probe must not seed the entity.');
  if (proof.defaultProbe.status === 403) {
    assert.equal(proof.defaultProbe.found, false, 'A real default repository HTTP 403 must remain a failed entity read.');
  }
  const selected = proof.selectedRepository;
  assert.ok(proof.discovery.some(entry => entry.status === 1 && entry.url === `${selected.base}/${selected.organisation}/${selected.repository}`),
    'The explicit JCB repository must be advertised as healthy by live package discovery.');
  assert.equal(new URL(selected.base).protocol, 'https:');
  assert.equal(selected.repository, 'packages');
  assert.equal(selected.branch, 'master');
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

function transportProgram(url, transport) {
  const encoded = Buffer.from(url).toString('base64');
  return `$url = base64_decode('${encoded}');\n` + (transport === 'curl' ? String.raw`
      $curl = curl_init($url);
      curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>30,
        CURLOPT_HTTPHEADER=>['Content-Type: application/json']]);
      $body = curl_exec($curl);
      $proof = ['transport'=>'curl', 'url'=>$url, 'status'=>curl_getinfo($curl, CURLINFO_RESPONSE_CODE),
        'body'=>$body, 'errno'=>curl_errno($curl), 'error'=>curl_error($curl)];
      curl_close($curl);` : String.raw`
      unset($http_response_header);
      error_clear_last();
      $context = stream_context_create(['http'=>['method'=>'GET', 'timeout'=>30, 'ignore_errors'=>true,
        'header'=>"Content-Type: application/json\r\n"]]);
      $body = @file_get_contents($url, false, $context);
      $status = 0;
      foreach ($http_response_header ?? [] as $header) {
        if (preg_match('~^HTTP/\S+\s+(\d+)~', $header, $match)) $status = (int) $match[1];
      }
      $proof = ['transport'=>'stream', 'url'=>$url, 'status'=>$status, 'body'=>$body,
        'error'=>$body === false ? (error_get_last()['message'] ?? 'HTTP stream failed') : ''];`);
}

export async function assertLiveNetworkApi(page) {
  const proof = [];
  for (const url of [apiBase, ...targets.map(target => apiBase + `community/jcb/${target}`)]) {
    for (const transport of ['curl', 'stream']) {
      // Each HTTP operation keeps its own PHP execution budget. Combining eight
      // valid requests can exceed max_execution_time despite individual timeouts.
      proof.push(await phpProbe(page, transportProgram(url, transport)));
    }
  }
  return assertNetworkApiProof(proof);
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
    // JCB 5.2/6.2 requests the singular discovery target "package" for its
    // default repository. Preserve that real failure, then use JCB's supported
    // explicit repository argument with a healthy live "packages" entry.
    $default = $grep->get($guid, ['remote']);
    $defaultPaths = $grep->getPaths() ?? [];
    $defaultPath = $defaultPaths[0] ?? null;
    $defaultBase = rtrim($defaultPath->base ?? 'https://git.vdm.dev', '/');
    $defaultUrl = $defaultBase . '/api/v1/repos/' . ($defaultPath->organisation ?? 'joomla')
      . '/' . ($defaultPath->repository ?? 'packages') . '/raw/index/field.json?ref=master';
    $curl = curl_init($defaultUrl);
    curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_TIMEOUT=>30]);
    curl_exec($curl); $defaultStatus = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $defaultErrno = curl_errno($curl); $defaultError = curl_error($curl); curl_close($curl);
    $db->setQuery($sql); $defaultAfter = $db->loadAssoc();
    $discovery = json_decode(file_get_contents('${apiBase}community/jcb/packages'), true, 512, JSON_THROW_ON_ERROR);
    if (($discovery['target'] ?? null) !== 'packages') throw new RuntimeException('Live package discovery target is invalid.');
    $repository = null;
    foreach ($discovery['network'] ?? [] as $entry) {
      if (($entry['status'] ?? null) !== 1) continue;
      $url = parse_url($entry['url']);
      if (($url['scheme'] ?? '') !== 'https' || ($url['path'] ?? '') !== '/joomla/packages'
        || isset($url['user']) || isset($url['pass']) || isset($url['port']) || isset($url['query']) || isset($url['fragment'])) continue;
      $repository = (object) ['base'=>'https://' . $url['host'], 'organisation'=>'joomla',
        'repository'=>'packages', 'read_branch'=>'master', 'target'=>'gitea'];
      break;
    }
    if ($repository === null || !$grep->validRepo($repository, 'packages')) throw new RuntimeException('No healthy live package repository is available.');
    $imported = \VDM\Joomla\Componentbuilder\Package\Factory::_('Field.Remote.Get')->item($guid, ['remote'], $repository);
    $db->setQuery($sql); $after = $db->loadAssoc();
    $db->setQuery('SELECT COUNT(*) FROM #__componentbuilder_field WHERE guid=' . $db->quote($guid));
    $count = (int) $db->loadResult();
    $repositories = [];
    foreach ([$repository] as $path) {
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
      'fixture'=>['target'=>'packages', 'ref'=>'master', 'guid'=>$guid], 'repositories'=>$repositories,
      'defaultProbe'=>['url'=>$defaultUrl, 'status'=>$defaultStatus, 'errno'=>$defaultErrno, 'error'=>$defaultError,
        'found'=>$default !== null, 'after'=>$defaultAfter],
      'discovery'=>$discovery['network'],
      'selectedRepository'=>['base'=>$repository->base, 'organisation'=>$repository->organisation,
        'repository'=>$repository->repository, 'branch'=>$repository->read_branch]];
  `);
  try { assertEntityImportProof(proof); }
  catch (error) { error.message += `\nEntity receipt: ${JSON.stringify(proof)}`; throw error; }
  return proof;
}

