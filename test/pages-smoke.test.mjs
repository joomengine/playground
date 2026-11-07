import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeNetworkConfig } from '../src/network-config.mjs';
import { verifyPublishedPlayground } from '../scripts/pages-smoke.mjs';

const commit = 'a'.repeat(40);
const buildId = 'b'.repeat(64);
const canonicalURL = 'https://playground.example.com/site/';
const relay = 'https://relay.example.com';

async function fixture(t, { endpoint = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pages-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = normalizeNetworkConfig({ endpoint });
  const manifest = { schemaVersion: 1, sourceCommit: commit, deployment: { environment: 'production', canonicalUrl: canonicalURL }, network: config };
  const files = new Map([
    ['assets/manifest.json', JSON.stringify(manifest)], ['config/network.json', JSON.stringify(config)],
    ['build.json', `${JSON.stringify({ schemaVersion: 1, id: buildId })}\n`],
    ['index.html', `<html><meta name="joomengine-build" content="${buildId}"><script src="./src/app.mjs"></script></html>`],
    ['src/app.mjs', 'export const application = true;\n'],
  ]);
  for (const [file, body] of files) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), body);
  }
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    calls.push({ url: url.href, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers);
    assert.equal(headers.has('Authorization'), false);
    assert.equal(headers.has('Cookie'), false);
    assert.equal(url.origin, new URL(canonicalURL).origin);
    const file = url.pathname.slice('/site/'.length) || 'index.html';
    assert.ok(files.has(file), `Unexpected asset: ${url}`);
    return new Response(files.get(file));
  };
  return { files, manifest, config, calls, fetcher, options: { directory, baseURL: 'https://project.github.io/site/',
    expectedCommit: commit, fetcher, timeoutMs: 1000, retryMs: 0, maxAttempts: 2 } };
}

test('post-publication smoke checks the canonical deployment with direct-only networking', async t => {
  const f = await fixture(t);
  const result = await verifyPublishedPlayground(f.options);
  assert.equal(result.url, canonicalURL);
  assert.equal(result.sourceCommit, commit);
  assert.equal(result.buildId, buildId);
  assert.equal(result.networkEndpoint, null);
  assert.equal(result.attempts, 1);
  assert.equal(f.calls.length, 5);
  assert.ok(f.calls.every(call => call.url.startsWith(canonicalURL)));
});

test('a configured fallback endpoint does not add a live proxy prerequisite to publication', async t => {
  const f = await fixture(t, { endpoint: relay });
  const result = await verifyPublishedPlayground(f.options);
  assert.equal(result.networkEndpoint, relay);
  assert.equal(f.calls.length, 5);
});

test('stale CDN manifest is retried and the entire current publication is then verified', async t => {
  const f = await fixture(t);
  const retries = [];
  let requests = 0;
  const result = await verifyPublishedPlayground({ ...f.options, onRetry: value => retries.push(value),
    fetcher: (url, init) => ++requests === 1
      ? Response.json({ ...f.manifest, sourceCommit: 'c'.repeat(40) }) : f.fetcher(url, init) });
  assert.equal(result.attempts, 2);
  assert.equal(requests, 6);
  assert.equal(retries.length, 1);
  assert.match(retries[0].message, /Published manifest differs/);
});

test('persistent stale manifest, configuration, shell and app content fail the publication smoke', async t => {
  for (const file of ['assets/manifest.json', 'config/network.json', 'build.json', 'index.html', 'src/app.mjs']) {
    const f = await fixture(t);
    if (file === 'assets/manifest.json') f.files.set(file, JSON.stringify({ ...f.manifest, sourceCommit: 'c'.repeat(40) }));
    else if (file === 'config/network.json') f.files.set(file, JSON.stringify({ ...f.config, endpoint: 'https://other.example.com' }));
    else f.files.set(file, 'stale content');
    await assert.rejects(verifyPublishedPlayground(f.options), /after 2 attempt\(s\): Published .* differs/);
  }
});

test('public config must be complete, normalized and free of unsupported settings', async t => {
  const f = await fixture(t);
  for (const invalid of [{}, { ...f.config, privateSetting: 'not-public' }]) {
    f.files.set('config/network.json', JSON.stringify(invalid));
    await assert.rejects(verifyPublishedPlayground({ ...f.options, maxAttempts: 1 }), /normalized configuration/);
  }
});

test('publication cannot pass against an artifact for another source commit or staging environment', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyPublishedPlayground({ ...f.options, expectedCommit: 'c'.repeat(40) }), /Artifact source commit differs/);
  await writeFile(path.join(f.options.directory, 'assets/manifest.json'), JSON.stringify({ ...f.manifest,
    deployment: { ...f.manifest.deployment, environment: 'staging' } }));
  await assert.rejects(verifyPublishedPlayground(f.options), /production artifact/);
  assert.equal(f.calls.length, 0);
});

test('HTTP failures, malformed JSON and oversized responses fail without accepting fallback content', async t => {
  const f = await fixture(t);
  for (const response of [new Response('unavailable', { status: 503 }), new Response('<html>not JSON</html>'),
    new Response('x'.repeat(65537))]) {
    await assert.rejects(verifyPublishedPlayground({ ...f.options, maxAttempts: 1,
      fetcher: async () => response }), /HTTP 200, received 503|JSON|size limit/);
  }
});

test('an unfinished public response is canceled by the bounded overall deadline', async t => {
  const f = await fixture(t);
  let aborted = false;
  const fetcher = async (url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason); }, { once: true });
    },
  }));
  await assert.rejects(verifyPublishedPlayground({ ...f.options, fetcher, timeoutMs: 25 }), /overall deadline/);
  assert.equal(aborted, true);
});

test('Pages preserves the downloaded candidate and runs smoke only after deployment, with failure propagation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('actions/checkout@') < workflow.indexOf('actions/download-artifact@'));
  assert.ok(workflow.indexOf('actions/deploy-pages@') < workflow.indexOf('run: node scripts/pages-smoke.mjs dist'));
  assert.match(workflow, /PAGES_URL: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.doesNotMatch(workflow, /continue-on-error|secrets\./);
});
