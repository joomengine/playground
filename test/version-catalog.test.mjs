import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { joomlaPackagePhpMinimum, stageVersionCatalog } from '../scripts/version-catalog.mjs';
import { discoverDynamicCatalog } from '../src/dynamic-catalog.mjs';
import { compatibleDynamicPhp } from '../src/dynamic-selection.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sha512 = bytes => createHash('sha512').update(bytes).digest('hex');
const zip = (text, php = '8.3.0') => Buffer.from(zipSync({ 'version.txt': strToU8(text),
  'index.php': strToU8(`<?php\ndefine('JOOMLA_MINIMUM_PHP', '${php}');\n`),
  'installation/index.php': strToU8(`<?php\n\\define('JOOMLA_MINIMUM_PHP', '${php}');\n`) }));
const stableBytes = zip('6.2.0');
const jcbBytes = zip('6.2.1-alpha1');
const stable = { version: '6.2.0', label: 'Joomla 6.2.0', source: 'release', channel: 'stable',
  url: 'https://publisher.test/joomla.zip', sha256: sha256(stableBytes), prerelease: false };
const jcb = { version: '6.2.1-alpha1', label: 'JCB 6.2.1-alpha1', source: 'jcb-update', channel: 'preview',
  url: 'https://publisher.test/jcb.zip', sha512: sha512(jcbBytes), prerelease: true };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playground-version-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, 'assets');
  await mkdir(assets);
  const requests = [];
  const configuration = { assets, cache: path.join(directory, 'cache'),
    discover: async () => ({ joomla: [stable], jcb: [jcb], errors: [] }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(url === stable.url ? stableBytes : jcbBytes);
    },
    now: () => Date.UTC(2026, 9, 31), ...options };
  return { configuration, requests,
    catalog: () => readFile(path.join(assets, 'version-catalog.json'), 'utf8').then(JSON.parse) };
}

test('published catalog serves exact verified ZIP bytes on its own origin and retains upstream provenance', async t => {
  const f = await fixture(t);
  assert.deepEqual(await stageVersionCatalog(f.configuration), { url: 'version-catalog.json', generatedAt: '2026-10-31T00:00:00.000Z' });
  const catalog = await f.catalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(catalog.errors, []);
  for (const [entry, original, expectedBytes] of [[catalog.joomla[0], stable, stableBytes], [catalog.jcb[0], jcb, jcbBytes]]) {
    assert.equal(entry.url, `packages/${sha256(expectedBytes)}.zip`);
    assert.equal(entry.sourceUrl, original.url);
    assert.equal(entry.sha256, sha256(expectedBytes));
    assert.equal(entry.channel, original.channel);
    const actual = await readFile(path.join(f.configuration.assets, entry.url));
    assert.deepEqual(actual, expectedBytes);
    assert.equal(new TextDecoder().decode(unzipSync(actual)['version.txt']), entry.version);
  }
  assert.equal(catalog.jcb[0].sha512, jcb.sha512);
  assert.equal(catalog.joomla[0].phpMinimum, '8.3.0');
  assert.ok(f.requests.every(request => request.init.credentials === 'omit' && request.init.cache === 'no-store'));
});

test('verified immutable cache avoids downloads while mutable nightlies refresh their content identity', async t => {
  let nightlyBytes = zip('first build');
  const nightly = { version: '7.0.0-alpha1-dev', label: 'Joomla nightly', source: 'nightly', channel: 'nightly',
    url: 'https://publisher.test/nightly.zip', phpMinimum: '8.3.0', sha256: null, prerelease: true };
  let nightlyDownloads = 0;
  let immutableDownloads = 0;
  const f = await fixture(t, {
    discover: async () => ({ joomla: [stable, nightly], jcb: [jcb], errors: [] }),
    fetchImpl: async url => {
      if (url === nightly.url) { nightlyDownloads++; return new Response(nightlyBytes); }
      immutableDownloads++;
      return new Response(url === stable.url ? stableBytes : jcbBytes);
    },
  });
  await stageVersionCatalog(f.configuration);
  const first = (await f.catalog()).joomla[1];
  nightlyBytes = zip('second build');
  await stageVersionCatalog(f.configuration);
  const second = (await f.catalog()).joomla[1];
  assert.equal(immutableDownloads, 2);
  assert.equal(nightlyDownloads, 2);
  assert.notEqual(first.sha256, second.sha256);
  assert.notEqual(first.url, second.url);
  assert.equal(second.sha256, sha256(nightlyBytes));
  assert.equal(second.phpMinimum, nightly.phpMinimum);
});

test('a corrupted immutable cache is replaced only by a freshly verified source', async t => {
  const f = await fixture(t);
  await stageVersionCatalog(f.configuration);
  const cached = path.join(f.configuration.cache, 'packages', `${jcb.sha512}.zip`);
  await writeFile(cached, zip('corrupted'));
  await stageVersionCatalog(f.configuration);
  assert.equal(f.requests.filter(request => request.url === jcb.url).length, 2);
  assert.deepEqual(await readFile(cached), jcbBytes);
});

test('a changed publisher checksum leaves the previous catalog untouched', async t => {
  const f = await fixture(t);
  await stageVersionCatalog(f.configuration);
  const previous = await f.catalog();
  await assert.rejects(stageVersionCatalog({ ...f.configuration,
    discover: async () => ({ joomla: [stable], jcb: [{ ...jcb, sha512: '0'.repeat(128) }], errors: [] }) }), /published sha512 checksum/);
  assert.deepEqual(await f.catalog(), previous);
});

test('partial metadata cannot publish an apparently complete catalog', async t => {
  const f = await fixture(t, { discover: async () => ({ joomla: [stable], jcb: [], errors: [{ source: 'jcb-6.x', message: 'HTTP 503' }] }) });
  await assert.rejects(stageVersionCatalog(f.configuration), /incomplete version catalog.*jcb-6.x/);
  assert.deepEqual(f.requests, []);
  await assert.rejects(f.catalog(), { code: 'ENOENT' });
});

const releasesURL = 'https://api.github.com/repos/joomla/joomla-cms/releases?per_page=100&page=1';
const discoverPinnedCatalog = options => discoverDynamicCatalog({ ...options,
  pinnedJoomla: [stable], pinnedJcb: [jcb], sources: { nightlyURLs: [], jcbURLs: [] } });

test('the build token authenticates release metadata without entering packages or the published catalog', async t => {
  const token = 'build-only-github-token';
  const requests = [];
  const f = await fixture(t, { githubToken: token, discover: discoverPinnedCatalog,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return url === releasesURL ? Response.json([]) : new Response(url === stable.url ? stableBytes : jcbBytes);
    } });
  await stageVersionCatalog(f.configuration);
  const metadata = requests.filter(request => request.url === releasesURL);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].init.headers.get('Authorization'), `Bearer ${token}`);
  assert.equal(metadata[0].init.redirect, 'error');
  assert.equal(metadata[0].init.credentials, 'omit');
  for (const request of requests.filter(request => request.url !== releasesURL)) {
    assert.equal(request.init.headers.get('Authorization'), null, 'Archive downloads must not carry the build token.');
  }
  const catalog = await f.catalog();
  assert.equal(JSON.stringify(catalog).includes(token), false);
  for (const entry of [...catalog.joomla, ...catalog.jcb]) {
    assert.equal((await readFile(path.join(f.configuration.assets, entry.url))).includes(Buffer.from(token)), false);
  }
});

test('build authentication is restricted to the exact HTTPS Joomla release metadata GET', async t => {
  const probes = [
    { url: releasesURL, method: 'POST' },
    { url: releasesURL.replace('https:', 'http:') },
    { url: releasesURL.replace('api.github.com', 'api.github.com.attacker.test') },
    { url: releasesURL.replace('api.github.com', 'user:password@api.github.com') },
    { url: releasesURL.replace('/releases?', '/releases/123?') },
    { url: 'https://api.github.com/repos/unrelated/repository/releases' },
    { url: 'https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/refs/heads/6.x/componentbuilder_update_server.xml' },
    { url: 'https://github.com/joomla/joomla-cms/releases/download/6.2.0/Joomla_6.2.0-Stable-Full_Package.zip' },
  ];
  const seen = [];
  const f = await fixture(t, { githubToken: 'scoped-build-token',
    discover: async ({ fetchImpl }) => {
      for (const { url, method } of probes) await fetchImpl(url, { method, redirect: 'follow' });
      return { joomla: [stable], jcb: [jcb], errors: [] };
    },
    fetchImpl: async (url, init) => {
      seen.push(url);
      assert.equal(init.headers.get('Authorization'), null, `Credentials must not be attached to ${url}.`);
      return new Response(url === stable.url ? stableBytes : jcbBytes);
    } });
  await stageVersionCatalog(f.configuration);
  assert.deepEqual(seen.slice(0, probes.length), probes.map(probe => probe.url));
});

test('local catalog builds without a token keep the public metadata request unauthenticated', async t => {
  const f = await fixture(t, { discover: discoverPinnedCatalog, fetchImpl: async (url, init) => {
    assert.equal(init.headers.get('Authorization'), null);
    if (url === releasesURL) {
      assert.equal(init.redirect, 'follow');
      return Response.json([]);
    }
    return new Response(url === stable.url ? stableBytes : jcbBytes);
  } });
  await stageVersionCatalog(f.configuration);
  assert.deepEqual((await f.catalog()).errors, []);
});

test('rejected or redirected authenticated metadata cannot replace a verified catalog', async t => {
  const token = 'never-serialize-this-token';
  for (const result of [401, 403, 302, 'redirect-error']) {
    const f = await fixture(t);
    await stageVersionCatalog(f.configuration);
    const previous = await f.catalog();
    let attempts = 0;
    await assert.rejects(stageVersionCatalog({ ...f.configuration, githubToken: token, discover: discoverPinnedCatalog,
      fetchImpl: async (url, init) => {
        assert.equal(url, releasesURL, 'Failed metadata must not start a package download.');
        assert.equal(init.headers.get('Authorization'), `Bearer ${token}`);
        assert.equal(init.redirect, 'error', 'Authenticated requests must not follow a redirect.');
        attempts++;
        if (result === 'redirect-error') throw new TypeError('Unexpected redirect');
        return new Response(token, { status: result, headers: { Location: 'https://attacker.test/collect' } });
      } }), error => {
        assert.match(error.message, /incomplete version catalog/);
        assert.equal(error.message.includes(token), false);
        return true;
      });
    assert.equal(attempts, 1, 'Permission errors and redirects must not be hidden by retries.');
    assert.deepEqual(await f.catalog(), previous);
  }
});

test('catalog metadata retries transient gateway failures within the same request deadline', async t => {
  for (const status of [502, 503, 504]) {
    const attempts = [];
    let cancelled = 0;
    const f = await fixture(t, { discover: discoverPinnedCatalog, fetchImpl: async (url, init) => {
      if (url !== releasesURL) return new Response(url === stable.url ? stableBytes : jcbBytes);
      attempts.push(init);
      return attempts.length === 1
        ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status })
        : Response.json([]);
    } });
    await stageVersionCatalog(f.configuration);
    assert.equal(attempts.length, 2, `HTTP ${status} must retry once before succeeding.`);
    assert.equal(cancelled, 1, 'The discarded response body must be cancelled.');
    assert.ok(attempts[0].signal instanceof AbortSignal);
    assert.equal(attempts[1].signal, attempts[0].signal, 'Retries must not extend the metadata deadline.');
    assert.ok(attempts.every(init => init.credentials === 'omit' && init.cache === 'no-store'
      && init.headers.get('User-Agent').includes('JoomEnginePlayground')));
    assert.deepEqual((await f.catalog()).errors, []);
  }
});

test('exhausted metadata retries preserve the previously published catalog', async t => {
  const f = await fixture(t);
  await stageVersionCatalog(f.configuration);
  const previous = await f.catalog();
  let attempts = 0;
  await assert.rejects(stageVersionCatalog({ ...f.configuration, discover: discoverPinnedCatalog,
    fetchImpl: async url => {
      assert.equal(url, releasesURL, 'Packages must not download after incomplete discovery.');
      attempts++;
      return new Response('Gateway timeout', { status: 504 });
    } }), /incomplete version catalog: joomla-releases: HTTP 504/);
  assert.equal(attempts, 3);
  assert.deepEqual(await f.catalog(), previous);
});

test('metadata retries do not mask permanent HTTP, parsing or connection errors', async t => {
  for (const response of [
    () => new Response('Not found', { status: 404 }),
    () => new Response('Invalid JSON'),
    () => { throw new TypeError('Connection failed'); },
  ]) {
    let attempts = 0;
    const f = await fixture(t, { discover: discoverPinnedCatalog, fetchImpl: async () => { attempts++; return response(); } });
    await assert.rejects(stageVersionCatalog(f.configuration), /incomplete version catalog/);
    assert.equal(attempts, 1);
    await assert.rejects(f.catalog(), { code: 'ENOENT' });
  }
});

test('an expired metadata deadline interrupts backoff without another request', async t => {
  let attempts = 0;
  let signal;
  const f = await fixture(t, {
    discover: options => {
      signal = AbortSignal.timeout(20);
      return discoverPinnedCatalog({ ...options, signal });
    },
    fetchImpl: async () => { attempts++; return new Response('Gateway timeout', { status: 504 }); },
  });
  await assert.rejects(stageVersionCatalog(f.configuration), { name: 'AbortError' });
  assert.equal(attempts, 1);
  assert.equal(signal.aborted, true);
  await assert.rejects(f.catalog(), { code: 'ENOENT' });
});

test('catalog metadata retry adapter never replays a non-GET request', async t => {
  let attempts = 0;
  const f = await fixture(t, {
    discover: async ({ fetchImpl }) => {
      const response = await fetchImpl(releasesURL, { method: 'POST' });
      return { joomla: [], jcb: [], errors: [{ source: 'metadata', message: `HTTP ${response.status}` }] };
    },
    fetchImpl: async () => { attempts++; return new Response('Gateway timeout', { status: 504 }); },
  });
  await assert.rejects(stageVersionCatalog(f.configuration), /incomplete version catalog: metadata: HTTP 504/);
  assert.equal(attempts, 1);
});

test('package delivery retries transient HTTP and HTML responses with one deadline before accepting verified bytes', async t => {
  const attempts = [];
  let cancelled = 0;
  const f = await fixture(t, { fetchImpl: async (url, init) => {
    if (url !== stable.url) return new Response(jcbBytes);
    attempts.push(init);
    if (attempts.length === 1) return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
    if (attempts.length === 2) return new Response('<html>Temporary download failure</html>', { headers: { 'Content-Type': 'text/html' } });
    return new Response(stableBytes);
  } });
  await stageVersionCatalog(f.configuration);
  assert.equal(attempts.length, 3);
  assert.equal(cancelled, 1, 'Discard the HTTP error body before retrying.');
  assert.ok(attempts.every(init => init.signal === attempts[0].signal
    && init.credentials === 'omit' && init.cache === 'no-store' && init.redirect === 'follow'));
  const catalog = await f.catalog();
  assert.equal(catalog.joomla[0].sha256, stable.sha256);
  assert.deepEqual(await readFile(path.join(f.configuration.assets, catalog.joomla[0].url)), stableBytes);
});

test('package delivery retries a connection failure and an interrupted body without retaining partial bytes', async t => {
  let attempts = 0;
  const f = await fixture(t, { fetchImpl: async url => {
    if (url !== stable.url) return new Response(jcbBytes);
    attempts++;
    if (attempts === 1) throw new TypeError('Connection reset');
    if (attempts === 2) {
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (sent) controller.error(new TypeError('Socket closed during download'));
        else { sent = true; controller.enqueue(stableBytes.subarray(0, 32)); }
      } }));
    }
    return new Response(stableBytes);
  } });
  await stageVersionCatalog(f.configuration);
  assert.equal(attempts, 3);
  const entry = (await f.catalog()).joomla[0];
  assert.deepEqual(await readFile(path.join(f.configuration.assets, entry.url)), stableBytes);
});

test('exhausted invalid package responses retain the prior catalog and expose bounded download diagnostics', async t => {
  const f = await fixture(t);
  await stageVersionCatalog(f.configuration);
  const previous = await f.catalog();
  let attempts = 0;
  const nightly = { ...stable, version: '7.0.0-alpha1-dev', channel: 'nightly', source: 'nightly', sha256: null,
    url: 'https://publisher.test/nightly.zip' };
  const body = '<html>Temporary download failure</html>';
  await assert.rejects(stageVersionCatalog({ ...f.configuration,
    discover: async () => ({ joomla: [nightly], jcb: [jcb], errors: [] }),
    fetchImpl: async url => {
      assert.equal(url, nightly.url);
      attempts++;
      const response = new Response(body, { headers: { 'Content-Type': 'text/html', 'Content-Length': String(body.length) } });
      Object.defineProperty(response, 'url', { value: 'https://cdn.publisher.test/nightly.zip?signature=temporary-secret' });
      return response;
    },
  }), error => {
    assert.match(error.message, /Cannot stage joomla 7\.0\.0-alpha1-dev: Package retrieval failed after 3 attempts/);
    assert.match(error.message, /not a ZIP archive/);
    for (const attempt of [1, 2, 3]) assert.ok(error.message.includes(`"attempt":${attempt}`));
    assert.ok(error.message.includes(`"source":"${nightly.url}"`));
    assert.ok(error.message.includes('"finalURL":"https://cdn.publisher.test/nightly.zip"'));
    assert.ok(error.message.includes('"status":200'));
    assert.ok(error.message.includes('"contentType":"text/html"'));
    assert.ok(error.message.includes(`"receivedBytes":${body.length}`));
    assert.ok(error.message.includes(`"firstBytes":"${Buffer.from(body).subarray(0, 16).toString('hex')}"`));
    assert.equal(error.message.includes('temporary-secret'), false);
    return true;
  });
  assert.equal(attempts, 3);
  assert.deepEqual(await f.catalog(), previous);
});

test('package retries do not mask permanent HTTP failures or published checksum mismatches', async t => {
  for (const response of [
    () => new Response('Not found', { status: 404 }),
    () => new Response('Forbidden', { status: 403 }),
    () => new Response(zip('wrong published bytes')),
  ]) {
    let attempts = 0;
    const f = await fixture(t, { fetchImpl: async () => { attempts++; return response(); } });
    await assert.rejects(stageVersionCatalog(f.configuration), /failed after 1 attempt:.*(?:HTTP 404|HTTP 403|published sha256 checksum)/);
    assert.equal(attempts, 1);
    await assert.rejects(f.catalog(), { code: 'ENOENT' });
  }
});

test('package deadline interrupts retry backoff without starting another download', async t => {
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  let attempts = 0;
  const f = await fixture(t, { fetchImpl: async () => {
    attempts++;
    const timer = setTimeout(() => controller.abort(new DOMException('Package deadline expired', 'TimeoutError')), 20);
    t.after(() => clearTimeout(timer));
    return new Response('Gateway timeout', { status: 504 });
  } });
  await assert.rejects(stageVersionCatalog(f.configuration), /Package retrieval deadline expired after 1 attempt/);
  assert.equal(attempts, 1);
  await assert.rejects(f.catalog(), { code: 'ENOENT' });
});

test('non-ZIP, oversized declared responses and oversized streams are rejected before catalog publication', async t => {
  for (const response of [
    () => new Response('<html>Download error</html>'),
    () => new Response(stableBytes, { headers: { 'Content-Length': '1025' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); controller.close(); } })),
  ]) {
    const f = await fixture(t, { maxPackageBytes: 1024, fetchImpl: async () => response() });
    await assert.rejects(stageVersionCatalog(f.configuration), /not a ZIP|exceeds 128 MiB/);
    await assert.rejects(f.catalog(), { code: 'ENOENT' });
  }
});

test('staged pinned Joomla archives are verified and reused without a second upstream download', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.configuration.assets, 'joomla'));
  await writeFile(path.join(f.configuration.assets, 'joomla', 'Joomla_6.2.0.zip'), stableBytes);
  await stageVersionCatalog({ ...f.configuration,
    stagedJoomla: [{ version: stable.version, sourceUrl: stable.url, sha256: stable.sha256, url: 'joomla/Joomla_6.2.0.zip' }] });
  assert.deepEqual(f.requests.map(request => request.url), [jcb.url]);
  assert.equal((await f.catalog()).joomla[0].url, 'joomla/Joomla_6.2.0.zip');
  await assert.rejects(readFile(path.join(f.configuration.assets, 'packages', `${stable.sha256}.zip`)), { code: 'ENOENT' });
  await writeFile(path.join(f.configuration.assets, 'joomla', 'Joomla_6.2.0.zip'), zip('corrupt staged file'));
  await assert.rejects(stageVersionCatalog({ ...f.configuration,
    stagedJoomla: [{ version: stable.version, sourceUrl: stable.url, sha256: stable.sha256, url: 'joomla/Joomla_6.2.0.zip' }] }), /published sha256 checksum/);
});

test('published Joomla 7 previews use the archive PHP requirement without a pinned Joomla 7 runtime entry', async t => {
  const bytes = zip('7.0.0-beta1', '8.4.0');
  const release = { version: '7.0.0-beta1', source: 'release', channel: 'preview', prerelease: true,
    url: 'https://publisher.test/joomla7.zip', sha256: sha256(bytes) };
  const f = await fixture(t, { discover: async () => ({ joomla: [release], jcb: [jcb], errors: [] }),
    fetchImpl: async url => new Response(url === release.url ? bytes : jcbBytes) });
  await stageVersionCatalog(f.configuration);
  const entry = (await f.catalog()).joomla[0];
  assert.equal(entry.phpMinimum, '8.4.0');
  assert.deepEqual(compatibleDynamicPhp(entry, {
    php: [{ version: '8.3', patchVersion: '8.3.29' }, { version: '8.4', patchVersion: '8.4.1' }, { version: '8.5', patchVersion: '8.5.2' }],
    joomla: [{ version: '6.2.0', php: ['8.3', '8.4', '8.5'] }],
  }), ['8.4', '8.5']);
});

test('archive inspection keeps stricter feed requirements and rejects incomplete or contradictory installers', () => {
  assert.equal(joomlaPackagePhpMinimum(zip('test', '8.4.1'), '8.3.0'), '8.4.1');
  assert.equal(joomlaPackagePhpMinimum(zip('test', '8.3.0'), '8.4.1'), '8.4.1');
  assert.throws(() => joomlaPackagePhpMinimum(zipSync({ 'index.php': strToU8("<?php\ndefine('JOOMLA_MINIMUM_PHP', '8.3.0');") })), /missing installation\/index.php/);
  const contradictory = unzipSync(zip('test', '8.3.0'));
  contradictory['installation/index.php'] = strToU8("<?php\ndefine('JOOMLA_MINIMUM_PHP', '8.4.0');");
  assert.throws(() => joomlaPackagePhpMinimum(zipSync(contradictory)), /disagree/);
  contradictory['installation/index.php'] = strToU8('<?php\n// no minimum declaration');
  assert.throws(() => joomlaPackagePhpMinimum(zipSync(contradictory)), /missing or ambiguous/);
  contradictory['installation/index.php'] = new Uint8Array(64 * 1024 + 1);
  assert.throws(() => joomlaPackagePhpMinimum(zipSync(contradictory)), /size limit/);
});

const priorCatalogURL = 'https://playground.example/assets/version-catalog.json';
const nightly = { version: '7.0.0-alpha1-dev', label: 'Joomla 7.0.0-alpha1-dev', source: 'nightly',
  channel: 'nightly', url: 'https://developer.joomla.org/nightlies/Joomla_7.0.0-alpha1-dev-Development-Full_Package.zip' };
const previousNightlyBytes = zip('older nightly');
const previousHash = sha256(previousNightlyBytes);
const priorZipURL = new URL(`packages/${previousHash}.zip`, priorCatalogURL).href;
const lastVerified = '2026-11-17T05:00:00.000Z';

function previousRelease(overrides = {}) {
  return { schemaVersion: 1, generatedAt: lastVerified, joomla: [{ ...nightly, sourceUrl: nightly.url,
    sha256: previousHash, url: `packages/${previousHash}.zip`, ...overrides }] };
}

async function nightlyOutageFixture(t, { upstream = () => new Response('', { status: 404 }),
  deployed = previousRelease(), deployedBytes = previousNightlyBytes,
  buildDate = '2026-11-19T04:00:00Z' } = {}) {
  const warnings = [], requests = [];
  const freshBytes = zip('another development line');
  const other = { ...nightly, version: '6.3.0-dev', url: 'https://publisher.test/other-nightly.zip' };
  const f = await fixture(t, { discover: async () => ({ joomla: [stable, nightly, other], jcb: [jcb], errors: [] }),
    previousCatalogURL: priorCatalogURL, onNightlyWarning: message => warnings.push(message), now: () => Date.parse(buildDate),
    fetchImpl: async (url, init) => {
      requests.push(url);
      if (url === nightly.url) return upstream();
      if (url === other.url) return new Response(freshBytes);
      if (url === stable.url) return new Response(stableBytes);
      if (url === jcb.url) return new Response(jcbBytes);
      assert.equal(init.headers.has('Authorization'), false);
      if (url === priorCatalogURL) return Response.json(deployed);
      if (url === priorZipURL) return new Response(deployedBytes);
      throw new Error('Unexpected origin or package');
    } });
  return { ...f, warnings, requests, other, freshBytes };
}

test('upstream HTML retains a recently verified nightly with its original date while other development lines refresh', async t => {
  let served = null;
  const f = await nightlyOutageFixture(t, { upstream: () => new Response(served || '<!DOCTYPE html><html>Service unavailable</html>') });
  await stageVersionCatalog(f.configuration);
  const catalog = await f.catalog();
  const retained = catalog.joomla.find(entry => entry.version === nightly.version);
  assert.equal(retained.sha256, previousHash);
  assert.equal(retained.verifiedAt, lastVerified);
  assert.equal(retained.nightlyStatus, 'retained');
  assert.match(retained.label, /last verified 2026-11-17/);
  assert.deepEqual(await readFile(path.join(f.configuration.assets, retained.url)), previousNightlyBytes);
  const fresh = catalog.joomla.find(entry => entry.version === f.other.version);
  assert.equal(fresh.sha256, sha256(f.freshBytes));
  assert.equal(fresh.verifiedAt, catalog.generatedAt);
  assert.deepEqual(catalog.warnings, f.warnings);
  assert.match(f.warnings[0], /Serving the verified package/);

  served = zip('latest build');
  await stageVersionCatalog(f.configuration);
  const recovered = (await f.catalog()).joomla.find(entry => entry.version === nightly.version);
  assert.equal(recovered.sha256, sha256(served));
  assert.equal(recovered.verifiedAt, catalog.generatedAt);
  assert.equal(recovered.nightlyStatus, undefined);
  assert.equal(recovered.label, nightly.label);
  assert.equal(f.requests.filter(url => url === priorCatalogURL).length, 1);
});

test('unavailable nightlies with expired, mismatched or missing previous packages do not block fresh supported choices', async t => {
  for (const deployed of [
    { ...previousRelease({ verifiedAt: '2026-11-15T01:00:00Z', nightlyStatus: 'retained' }), generatedAt: '2026-11-18T23:00:00Z' },
    previousRelease({ sourceUrl: 'https://publisher.test/other.zip' }),
    previousRelease({ url: 'https://elsewhere.test/file.zip' }),
    { schemaVersion: 1, joomla: [] },
  ]) {
    const f = await nightlyOutageFixture(t, { deployed });
    await stageVersionCatalog(f.configuration);
    const catalog = await f.catalog();
    assert.deepEqual(catalog.joomla.map(entry => entry.version), [stable.version, f.other.version]);
    assert.equal(f.requests.includes(priorZipURL), false);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /Omitted/);
  }
});

test('a changed prior package or invalid live ZIP still stops publication', async t => {
  const corrupted = await nightlyOutageFixture(t, { deployedBytes: zip('substituted') });
  await assert.rejects(stageVersionCatalog(corrupted.configuration), /published sha256 checksum/);
  await assert.rejects(corrupted.catalog(), { code: 'ENOENT' });
  const invalid = await nightlyOutageFixture(t, { upstream: () => new Response(zipSync({ 'wrong.txt': strToU8('hello') })) });
  await assert.rejects(stageVersionCatalog(invalid.configuration), /missing index.php/);
  assert.equal(invalid.requests.includes(priorCatalogURL), false);
});

test('nightly discovery uses the matching official XML mirror and isolates only feeds unavailable in both places', async t => {
  const base = 'https://update.joomla.org/core/nightlies/';
  const mirroredBase = 'https://raw.githubusercontent.com/joomla/update.joomla.org/master/www/core/nightlies/';
  const liveVersion = '6.3.0-alpha1-dev';
  const update = `https://developer.joomla.org/nightlies/Joomla_${liveVersion}-Development-Update_Package.zip`;
  const full = update.replace('Update_Package', 'Full_Package');
  const list = `<extensionset><extension type="file" element="joomla" detailsurl="${base}next_minor_extension.xml"/></extensionset>`;
  const xml = `<updates><update><version>${liveVersion}</version><php_minimum>8.3.0</php_minimum><downloadurl>${update}</downloadurl></update></updates>`;
  const requests = [], warnings = [];
  const f = await fixture(t, { previousCatalogURL: priorCatalogURL, onNightlyWarning: message => warnings.push(message),
    githubToken: 'metadata-only', discover: options => discoverDynamicCatalog({ ...options, pinnedJoomla: [stable], pinnedJcb: [jcb],
      sources: { nightlyURLs: [base + 'next_major_list.xml', base + 'next_minor_list.xml'], jcbURLs: [] } }),
    fetchImpl: async (url, init) => {
      requests.push(url);
      if (url === releasesURL) return Response.json([]);
      assert.equal(init.headers.has('Authorization'), false);
      if (url === stable.url || url === full) return new Response(stableBytes);
      if (url === jcb.url) return new Response(jcbBytes);
      if (url === mirroredBase + 'next_minor_list.xml') return new Response(list);
      if (url === mirroredBase + 'next_minor_extension.xml') return new Response(xml);
      if (url.startsWith(base) || url === mirroredBase + 'next_major_list.xml') return new Response('<html>Unavailable</html>');
      assert.fail(`Unexpected URL: ${url}`);
    } });
  await stageVersionCatalog(f.configuration);
  const catalog = await f.catalog();
  assert.deepEqual(catalog.joomla.map(entry => entry.version), [stable.version, liveVersion]);
  assert.equal(catalog.joomla[1].sourceUrl, full);
  assert.deepEqual(catalog.warnings, warnings);
  assert.match(warnings[0], /next_major_list\.xml/);
  assert.equal(warnings.length, 1);
  assert.ok(requests.includes(mirroredBase + 'next_minor_extension.xml'));
});
