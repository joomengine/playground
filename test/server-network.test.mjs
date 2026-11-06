import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStaticServer } from './server.mjs';
import { createNetworkTransport } from '../src/network-transport.mjs';

test('generic browser hosting isolates production verification without changing the artifact or explicit network fixtures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'playground-test-network-'));
  let server;
  try {
    const production = JSON.stringify({ schemaVersion: 1, enabled: true,
      endpoint: 'https://production.example.test', turnstileSiteKey: 'production-site-key' });
    await mkdir(path.join(directory, 'config'));
    await writeFile(path.join(directory, 'config/network.json'), production);
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Unchanged artifact</title>');
    const fixtures = {};
    server = await createStaticServer({ directory, prefix: '/nested/playground/', fixtures });
    const configURL = new URL('config/network.json', server.url);
    const config = await (await fetch(configURL)).json();
    let verificationRequests = 0;
    const transport = createNetworkTransport(() => { throw new TypeError('Browser CORS failure'); }, config, {
      getSession() { verificationRequests++; throw new Error('Unexpected production verification'); },
    });
    await assert.rejects(transport('https://update.joomla.org/cms/17.root.json'), { code: 'DIRECT_NETWORK_FAILED' });
    assert.equal(verificationRequests, 0, 'An unrelated Joomla background request must not open human verification in a generic UI test.');
    assert.equal(await readFile(path.join(directory, 'config/network.json'), 'utf8'), production);
    assert.equal(await (await fetch(server.url)).text(), '<!doctype html><title>Unchanged artifact</title>');

    fixtures['config/network.json'] = () => production;
    assert.equal(await (await fetch(configURL)).text(), production, 'Explicit network fixtures retain their enabled configuration.');
    delete fixtures['config/network.json'];
    assert.equal((await (await fetch(configURL)).json()).enabled, false);
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
