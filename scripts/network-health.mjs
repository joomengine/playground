import assert from 'node:assert/strict';
const endpoint = process.env.NETWORK_ENDPOINT;
assert.ok(endpoint, 'NETWORK_ENDPOINT is required.');
const url = new URL(endpoint);
assert.equal(url.protocol, 'https:', 'Hosted endpoint checks require HTTPS.');
assert.equal(url.origin, endpoint, 'NETWORK_ENDPOINT must be an exact origin.');
const response = await fetch(`${endpoint}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200);
const result = await response.json();
assert.equal(result.version, 1); assert.equal(result.enabled, true); assert.equal(result.mode, 'controlled-origins');
const rejected = await fetch(`${endpoint}/v1/fetch`, { method: 'POST', headers: { Origin: 'https://unapproved.example.com' },
  redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(rejected.status, 403, 'A caller outside the origin policy must be rejected.');
console.log(JSON.stringify({ endpoint, protocolVersion: 1, enabled: true, unauthorizedOriginRejected: true }));
