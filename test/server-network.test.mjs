import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStaticServer } from './server.mjs';

test('browser tests serve the actual network configuration unless a fixture explicitly replaces it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'playground-test-network-'));
  let server;
  try {
    const production = JSON.stringify({ endpoint: 'https://production.example.test' });
    await mkdir(path.join(directory, 'config'));
    await writeFile(path.join(directory, 'config/network.json'), production);
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Unchanged artifact</title>');
    const fixtures = {};
    server = await createStaticServer({ directory, prefix: '/nested/playground/', fixtures });
    const configURL = new URL('config/network.json', server.url);
    assert.equal(await (await fetch(configURL)).text(), production);
    assert.equal(await readFile(path.join(directory, 'config/network.json'), 'utf8'), production);
    assert.equal(await (await fetch(server.url)).text(), '<!doctype html><title>Unchanged artifact</title>');

    const fixture = JSON.stringify({ endpoint: 'http://127.0.0.1:8080' });
    fixtures['config/network.json'] = () => fixture;
    assert.equal(await (await fetch(configURL)).text(), fixture);
    delete fixtures['config/network.json'];
    assert.equal(await (await fetch(configURL)).text(), production);
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
