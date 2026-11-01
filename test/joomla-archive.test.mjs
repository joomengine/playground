import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { catalogWithSelectedJoomlaPackage, normalizeConfiguration, parseCatalog } from '../src/config.mjs';
import { dynamicJoomlaChoices } from '../src/dynamic-selection.mjs';

const version = '6.2.0';
const checksum = 'a'.repeat(64);
const manifest = {
  php: [{ version: '8.4' }],
  joomla: [{ version, url: `joomla/Joomla_${version}.zip`, sha256: checksum, php: ['8.4'] }],
  defaults: { joomlaVersion: version, phpVersion: '8.4' },
};
const administrator = { name: 'Archive test', username: 'archivetest', password: 'Archive-test!12345', email: 'archive@example.test' };

function selectedProfile(published, selection, baseURL) {
  const input = { deployId: 'servicedirectory', joomlaVersion: version, phpVersion: '8.4',
    jcbVersion: 'none', admin: administrator, joomlaPackage: structuredClone(selection) };
  const catalog = catalogWithSelectedJoomlaPackage(published, input, baseURL);
  return { catalog, configuration: normalizeConfiguration(input, { catalog, baseURL }) };
}

test('catalog refresh and deployment switching preserve the manifest-relative Joomla archive URL', () => {
  for (const baseURL of ['https://playground.example/', 'https://playground.example/preview/']) {
    const manifestURL = new URL('assets/manifest.json', baseURL);
    const published = parseCatalog(manifest, { baseURL: manifestURL });
    const current = published.joomla[0];
    const selected = new Map([[version, { ...current }]]);
    const refreshed = { ...published, joomla: dynamicJoomlaChoices(published, [], selected) };
    const { configuration } = selectedProfile(refreshed, selected.get(version), baseURL);
    assert.equal(configuration.joomlaPackage.url, new URL(manifest.joomla[0].url, manifestURL).href);
    assert.equal(configuration.joomlaPackage.sha256, checksum);
    assert.deepEqual(configuration.joomlaPackage.php, ['8.4']);
  }
  assert.equal(manifest.joomla[0].url, `joomla/Joomla_${version}.zip`, 'Parsing must not alter the published manifest.');
});

test('previously saved wrong-base URLs recover only the exact published Joomla bytes', () => {
  for (const baseURL of ['https://playground.example/', 'https://playground.example/preview/']) {
    const manifestURL = new URL('assets/manifest.json', baseURL);
    const published = parseCatalog(manifest, { baseURL: manifestURL });
    const legacy = { ...manifest.joomla[0], url: new URL(manifest.joomla[0].url, baseURL).href };
    const { configuration, catalog } = selectedProfile(published, legacy, baseURL);
    const expected = new URL(manifest.joomla[0].url, manifestURL).href;
    assert.equal(catalog.joomla[0].url, expected);
    assert.equal(configuration.joomlaPackage.url, expected);
    assert.equal(configuration.joomlaPackage.sha256, checksum);
    assert.equal(legacy.url, new URL(manifest.joomla[0].url, baseURL).href, 'The saved input must not be mutated.');
  }
});

test('custom sources and different Joomla checksums are never silently replaced', () => {
  const baseURL = 'https://playground.example/';
  const published = parseCatalog(manifest, { baseURL: new URL('assets/manifest.json', baseURL) });
  for (const selection of [
    { ...manifest.joomla[0], url: 'https://downloads.example/custom.zip' },
    { ...manifest.joomla[0], url: new URL(manifest.joomla[0].url, baseURL).href, sha256: 'b'.repeat(64) },
    { ...manifest.joomla[0], url: 'https://playground.example/custom.zip' },
  ]) {
    const { configuration } = selectedProfile(published, selection, baseURL);
    assert.equal(configuration.joomlaPackage.url, selection.url);
    assert.equal(configuration.joomlaPackage.sha256, selection.sha256);
  }
});

test('a switched Service Directory profile fetches the staged ZIP rather than the missing root path', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(request.url === `/preview/assets/${manifest.joomla[0].url}` ? 200 : 404,
      { 'Content-Type': 'application/zip' });
    response.end('archive fixture');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseURL = `http://127.0.0.1:${server.address().port}/preview/`;
    const published = parseCatalog(manifest, { baseURL: new URL('assets/manifest.json', baseURL) });
    const selected = new Map([[version, { ...published.joomla[0] }]]);
    const refreshed = { ...published, joomla: dynamicJoomlaChoices(published, [], selected) };
    const { configuration } = selectedProfile(refreshed, selected.get(version), baseURL);
    const response = await fetch(configuration.joomlaPackage.url);
    assert.equal(response.status, 200);
    assert.deepEqual(requests, [`/preview/assets/${manifest.joomla[0].url}`]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
