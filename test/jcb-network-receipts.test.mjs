import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNetworkApiProof } from './jcb-network-contract.mjs';
import { repositoryHostsFromDiscovery, publicNetworkURL, successfulRead } from './jcb-network-receipts.mjs';

const apiBase = 'https://api.joomlacomponentbuilder.com/v1/network/';
const indexPath = '/api/v1/repos/joomla/super-powers/raw/super-powers.json';
const indexSuffix = '/super-powers/raw/super-powers.json';

function discovery(mirrors) {
  const targets = ['super-powers', 'joomla-powers', 'packages'].map(target => ({
    target, network: mirrors.map(({ origin, status }) => ({ status, url: `${origin}/joomla/${target}` })),
  }));
  const documents = [
    ['', { systems: [{ projects: [{ project: 'jcb', targets }] }] }],
    ...targets.map(document => [`community/jcb/${document.target}`, document]),
  ];
  return assertNetworkApiProof(['curl', 'stream'].flatMap(transport => documents.map(([suffix, body]) => ({
    transport, url: apiBase + suffix, status: 200, body: JSON.stringify(body), error: '',
    ...(transport === 'curl' ? { errno: 0 } : {}),
  }))));
}

test('live discovery supplies new mirror hosts and retains advertised unhealthy mirror evidence', () => {
  const hosts = repositoryHostsFromDiscovery(discovery([
    { origin: 'https://codefloe.com', status: 1 },
    { origin: 'https://codeberg.org', status: 0 },
  ]));
  assert.deepEqual([...hosts].sort(), ['codeberg.org', 'codefloe.com']);
  for (const host of hosts) {
    const url = `https://${host}${indexPath}?ref=master`;
    assert.equal(publicNetworkURL(url, hosts), url);
    assert.deepEqual(successfulRead([{ event: 'response', url, status: 200, contentType: 'application/json' }],
      indexSuffix, 'The Power index'), {
      url, status: 200, resolvedOrigin: `https://${host}`, requestedRef: 'master',
    });
  }
});

test('a future mirror works from discovery alone and removed mirrors stop being observed', () => {
  const url = `https://new-forge.example${indexPath}?ref=master`;
  const original = repositoryHostsFromDiscovery(discovery([{ origin: 'https://codeberg.org', status: 1 }]));
  assert.equal(publicNetworkURL(url, original), null);
  const updated = repositoryHostsFromDiscovery(discovery([{ origin: 'https://new-forge.example', status: 1 }]));
  assert.equal(publicNetworkURL(url, updated), url);
  assert.equal(publicNetworkURL(`https://codeberg.org${indexPath}`, updated), null);
});

test('receipt URLs retain discovery visibility and exclude unrelated or private URL data', () => {
  const hosts = repositoryHostsFromDiscovery(discovery([{ origin: 'https://codefloe.com', status: 1 }]));
  assert.equal(publicNetworkURL(`${apiBase}community/jcb/super-powers`, new Set()),
    `${apiBase}community/jcb/super-powers`);
  for (const url of [
    'not a URL',
    `https://unadvertised.example${indexPath}`,
    `http://codefloe.com${indexPath}`,
    `https://user:secret@codefloe.com${indexPath}`,
    `https://codefloe.com${indexPath}#secret`,
    `https://codefloe.com${indexPath}?token=secret`,
    `https://codefloe.com${indexPath}?ref=master&token=secret`,
    'https://codefloe.com/api/v1/repos/another-owner/super-powers/raw/super-powers.json',
    'https://codefloe.com/unrelated/super-powers.json',
    'https://api.joomlacomponentbuilder.com/unrelated',
  ]) assert.equal(publicNetworkURL(url, hosts), null, `Exclude ${url}`);
  assert.equal(publicNetworkURL(`https://codefloe.com${indexPath}`, undefined), null);
});

test('existing GitHub package endpoint shapes still require an observed repository host', () => {
  const hosts = new Set(['api.github.com', 'raw.githubusercontent.com']);
  for (const url of [
    'https://api.github.com/repos/joomengine/packages/contents/index/field.json?ref=master',
    'https://raw.githubusercontent.com/joomengine/packages/master/index/field.json',
  ]) {
    assert.equal(publicNetworkURL(url, hosts), url);
    assert.equal(publicNetworkURL(url, new Set()), null);
  }
});

test('empty or malformed discovery fails rather than granting a broad receipt allowlist', () => {
  for (const proof of [null, [], [{}], [{ networks: [] }], [{ networks: [{}] }], [{ networks: [{ mirrors: [] }] }]]) {
    assert.throws(() => repositoryHostsFromDiscovery(proof), /Discovery proof|discovered network/);
  }
  for (const mirror of [
    null,
    { status: 2, url: 'https://codefloe.com/joomla/super-powers' },
    { status: 1, url: 'not a URL' },
    { status: 1, url: 'http://codefloe.com/joomla/super-powers' },
    { status: 1, url: 'https://user:secret@codefloe.com/joomla/super-powers' },
    { status: 1, url: 'https://codefloe.com/joomla/super-powers?token=secret' },
    { status: 1, url: 'https://codefloe.com/joomla/super-powers#secret' },
  ]) assert.throws(() => repositoryHostsFromDiscovery([{ networks: [{ mirrors: [mirror] }] }]),
    /Discovered mirror|discovered repository mirror|Discovered mirrors/);
});

test('the exact successful repository response is still required after discovery', () => {
  const url = `https://codefloe.com${indexPath}?ref=master`;
  const response = { event: 'response', url, status: 200, contentType: 'application/json' };
  for (const failed of [
    { ...response, event: 'request' },
    { ...response, event: 'requestfailed' },
    { ...response, status: 403 },
    { ...response, status: 500 },
    { ...response, contentType: 'text/html; charset=utf-8' },
    { ...response, url: 'https://codefloe.com/api/v1/repos/joomla/packages/raw/super-powers.json?ref=master' },
    { ...response, url: 'https://codefloe.com/api/v1/repos/joomla/super-powers/raw/other.json?ref=master' },
  ]) assert.throws(() => successfulRead([failed], indexSuffix, 'The Power index'),
    /must have an observed successful real repository response/);
  const fallback = { ...response, url: `https://codeberg.org${indexPath}?ref=master` };
  assert.equal(successfulRead([response, { ...response, contentType: 'text/html' }, fallback],
    indexSuffix, 'The Power index').url, fallback.url);
});
