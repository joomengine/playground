import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

/** Public checks shared by Worker deployment and the post-publication Pages smoke. */
export async function checkNetworkHealth(endpoint, { fetcher = fetch, signal } = {}) {
  assert.ok(endpoint, 'NETWORK_ENDPOINT is required.');
  const url = new URL(endpoint);
  assert.equal(url.protocol, 'https:', 'Hosted endpoint checks require HTTPS.');
  assert.equal(url.origin, endpoint, 'NETWORK_ENDPOINT must be an exact origin.');
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await fetcher(`${endpoint}/healthz`, { redirect: 'error', credentials: 'omit', signal: requestSignal() });
  if (response.status !== 200) {
    await response.body?.cancel();
    assert.fail(`Network health endpoint must return HTTP 200, received ${response.status}.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= 4096, 'Network health response exceeds its size limit.');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks));
  assert.equal(result.version, 1); assert.equal(result.enabled, true); assert.equal(result.mode, 'controlled-origins');
  const rejected = await fetcher(`${endpoint}/v1/fetch`, { method: 'POST', headers: { Origin: 'https://unapproved.example.com' },
    redirect: 'error', credentials: 'omit', signal: requestSignal() });
  await rejected.body?.cancel();
  assert.equal(rejected.status, 403, 'A caller outside the origin policy must be rejected.');
  return { endpoint, protocolVersion: 1, enabled: true, unauthorizedOriginRejected: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkNetworkHealth(process.env.NETWORK_ENDPOINT)));
}
