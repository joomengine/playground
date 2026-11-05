import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNetworkTransport } from '../src/network-transport.mjs';
import { createNetworkFixture, fixtureOrigin, writeOrigin, binaryHash, compressedLength } from './network-fixture.mjs';

test('client protocol interoperates with the actual Worker over HTTP for sessions, binary bodies and errors', async () => {
  const fixture = await createNetworkFixture({ directory: '.' });
  try {
    const origin = new URL(fixture.url).origin;
    let sessions = 0;
    const dispatch = (url, init = {}) => {
      if (!String(url).startsWith(fixture.relayOrigin)) throw new TypeError('Controlled direct transport failure');
      return fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Origin: origin } });
    };
    let session;
    const transport = createNetworkTransport(dispatch, fixture.config, { allowInsecureLocalhost: true,
      getSession: async () => {
        if (!session) {
          const response = await dispatch(`${fixture.relayOrigin}/v1/session`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, turnstileToken: 'fixture' }) });
          assert.equal(response.status, 200); session = await response.json(); sessions++;
        }
        return session;
      },
    });
    const binary = await transport(`${fixtureOrigin}/denied/binary`);
    assert.equal(binary.status, 200); assert.equal(binary.url, `${fixtureOrigin}/denied/binary`);
    assert.equal(createHash('sha256').update(new Uint8Array(await binary.arrayBuffer())).digest('hex'), binaryHash);
    const payload = new Uint8Array([0, 255, 65, 128]);
    const upload = await transport(`${writeOrigin}/denied/echo`, { method: 'PATCH', headers: {
      Authorization: 'Bearer upstream-fixture', 'Content-Type': 'application/octet-stream',
    }, body: payload });
    assert.deepEqual(new Uint8Array(await upload.arrayBuffer()), payload);
    const received = fixture.requests.filter(item => item.method === 'PATCH');
    assert.equal(received.length, 1); assert.equal(received[0].headers.authorization, 'Bearer upstream-fixture');
    assert.equal(received[0].headers['x-playground-request'], undefined);
    for (const status of [204, 304, 401, 403, 404, 429, 500]) {
      const response = await transport(`${writeOrigin}/denied/status/${status}`);
      assert.equal(response.status, status); await response.arrayBuffer();
    }
    const created = await transport(`${writeOrigin}/denied/status-text`);
    assert.equal(created.status, 201); assert.equal(created.statusText, 'Créé');
    assert.equal(await created.text(), 'created');
    for (const [method, resource, status] of [['HEAD', 'compressed', 200], ['GET', 'compressed-not-modified', 304]]) {
      const response = await transport(`${writeOrigin}/denied/${resource}`, { method });
      assert.equal(response.status, status); assert.equal((await response.arrayBuffer()).byteLength, 0);
      assert.equal(response.headers.get('content-encoding'), 'gzip');
      assert.equal(response.headers.get('content-length'), String(compressedLength));
    }
    const decoded = await transport(`${writeOrigin}/denied/compressed`);
    assert.equal(createHash('sha256').update(new Uint8Array(await decoded.arrayBuffer())).digest('hex'), binaryHash);
    assert.equal(decoded.headers.get('content-encoding'), null); assert.equal(decoded.headers.get('content-length'), null);
    const before = fixture.relayRequests.length;
    await assert.rejects(transport(`${fixtureOrigin}/denied/echo`, { method: 'POST', body: 'once' }), { code: 'DIRECT_NETWORK_FAILED' });
    assert.equal(fixture.relayRequests.length, before);
    assert.equal(sessions, 1);
    await assert.rejects(transport(`${writeOrigin}/denied/forbidden-redirect`), { code: 'DESTINATION_NOT_ALLOWED' });
    fixture.setAvailable(false);
    await assert.rejects(transport(`${fixtureOrigin}/denied/binary`), { code: 'RELAY_PROTOCOL_ERROR' });
  } finally { await fixture.close(); }
});
