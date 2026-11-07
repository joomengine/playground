import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { normalizeNetworkConfig } from '../src/network-config.mjs';

const files = ['assets/manifest.json', 'config/network.json', 'build.json', 'index.html', 'src/app.mjs'];

function publicURL(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'The published Pages URL must be HTTPS without credentials or query parameters.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function publicBytes(url, limit, fetcher, overallSignal) {
  const signal = AbortSignal.any([overallSignal, AbortSignal.timeout(20000)]);
  const response = await fetcher(url, { redirect: 'error', credentials: 'omit', cache: 'no-cache', signal });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${url.pathname}: expected HTTP 200, received ${response.status}.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${url.pathname}: published response exceeds its size limit.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Compare the actual public deployment with the artifact that passed validation. */
export async function verifyPublishedPlayground({ directory = 'dist', baseURL, expectedCommit,
  fetcher = fetch, timeoutMs = 180000, retryMs = 10000, maxAttempts = 18, onRetry = () => {} } = {}) {
  publicURL(baseURL);
  assert.match(expectedCommit || '', /^[a-f0-9]{40}$/, 'The tested source commit is required.');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && Number.isSafeInteger(maxAttempts) && maxAttempts > 0);
  const expected = new Map(await Promise.all(files.map(async file => [file, await readFile(path.join(directory, file))])));
  const manifest = JSON.parse(expected.get(files[0]));
  const config = JSON.parse(expected.get(files[1]));
  const normalized = normalizeNetworkConfig(config);
  const build = JSON.parse(expected.get(files[2]));
  // Pages may report a github.io URL that redirects to the reviewed CNAME.
  // Probe the tested artifact's canonical URL directly, without following redirects.
  const base = publicURL(manifest.deployment?.canonicalUrl);
  assert.equal(manifest.deployment?.environment, 'production', 'Pages smoke requires the tested production artifact.');
  assert.equal(manifest.sourceCommit, expectedCommit, 'Artifact source commit differs from this publication.');
  assert.ok(isDeepStrictEqual(config, normalized) && isDeepStrictEqual(manifest.network, normalized),
    'Tested manifest and network configuration must contain the complete normalized public schema.');
  assert.equal(build.schemaVersion, 1);
  assert.match(build.id || '', /^[a-f0-9]{64}$/);
  assert.ok(expected.get('index.html').includes(Buffer.from(`<meta name="joomengine-build" content="${build.id}">`)),
    'Tested shell must carry its build identity.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Publication smoke exceeded its overall deadline.')), timeoutMs);
  let lastError;
  let attempts = 0;
  try {
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      try {
        controller.signal.throwIfAborted();
        for (const file of files) {
          const actual = await publicBytes(new URL(file === 'index.html' ? './' : file, base),
            Math.max(65536, expected.get(file).length + 1024), fetcher, controller.signal);
          if (file === 'assets/manifest.json') {
            assert.ok(isDeepStrictEqual(JSON.parse(actual), manifest), 'Published manifest differs from the tested artifact.');
          } else if (file === 'config/network.json') {
            const publicConfig = JSON.parse(actual);
            assert.ok(isDeepStrictEqual(publicConfig, normalizeNetworkConfig(publicConfig))
              && isDeepStrictEqual(publicConfig, normalized), 'Published network configuration differs from the tested normalized configuration.');
          } else {
            assert.ok(actual.equals(expected.get(file)), `Published ${file} differs from the tested artifact.`);
          }
        }
        return { url: base.href, sourceCommit: manifest.sourceCommit, buildId: build.id, attempts,
          networkEndpoint: normalized.endpoint };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || attempts === maxAttempts) break;
        onRetry({ attempt: attempts, message: error.message });
        try { await delay(retryMs, undefined, { signal: controller.signal }); }
        catch { break; }
      }
    }
    throw new Error(`Published playground did not match the tested deployment after ${attempts} attempt(s): ${lastError?.message}`, { cause: lastError });
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyPublishedPlayground({ directory: process.argv[2] || 'dist',
    baseURL: process.env.PAGES_URL, expectedCommit: process.env.GITHUB_SHA,
    onRetry: ({ attempt, message }) => console.warn(`Publication smoke attempt ${attempt}: ${message}`) })));
}
