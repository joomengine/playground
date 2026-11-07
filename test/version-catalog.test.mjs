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
