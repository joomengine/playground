import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackageSource, hasPackageAuthentication, resolvePackageRequest, downloadExtensionPackage } from '../src/package-sources.mjs';

const bytes = new Uint8Array([80, 75, 3, 4, 0, 255, 128]);
const archive = () => new Response(bytes, { headers: { 'Content-Type': 'application/zip' } });

test('package descriptors preserve supported access data and reject incomplete credentials without echoing them', () => {
  const source = { url: '../extension.zip', provider: 'gitea', apiBase: 'https://git.example/api/v1/',
    authentication: { type: 'header', name: 'X-Download-Key', value: 'private-value' }, headers: { Accept: 'application/zip' } };
  assert.deepEqual(normalizePackageSource(source, 'https://git.example/packages/'), { ...source,
    url: 'https://git.example/extension.zip', apiBase: 'https://git.example/api/v1',
    authentication: { ...source.authentication, name: 'x-download-key' }, headers: { accept: 'application/zip' } });
  assert.equal(hasPackageAuthentication(source), true);
  assert.equal(hasPackageAuthentication({ url: source.url }), false);
  assert.equal(hasPackageAuthentication({ headers: { Accept: 'application/zip' } }), true);
  for (const entry of [
    { url: 'https://name:private-value@git.example/file.zip' },
    { url: 'https://git.example/file.zip', authentication: { type: 'bearer', token: 'private-value\nInjected: true' } },
    { url: 'https://git.example/file.zip', authentication: { type: '__proto__' } },
    { url: 'https://git.example/file.zip', authentication: { type: 'basic', username: 'name', password: '' } },
    { url: 'https://git.example/file.zip', headers: { Host: 'private-value' } },
  ]) assert.throws(() => normalizePackageSource(entry), error => Boolean(error.i18nKey) && !error.message.includes('private-value'));
});

test('GitHub private release links resolve metadata then download binary asset with bearer access', async () => {
  const requests = [];
  const downloaded = await downloadExtensionPackage({
    url: 'https://github.com/team/extension/releases/download/v1.2/package.zip',
    authentication: { type: 'token', token: 'github-private' },
  }, { fetcher: async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.headers.get('authorization'), 'Bearer github-private');
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    return requests.length === 1
      ? Response.json({ assets: [{ id: 42, name: 'package.zip', browser_download_url: 'https://unexpected.example/ignored' }] }) : archive();
  } });
  assert.deepEqual(downloaded, bytes);
  assert.equal(requests[0].url, 'https://api.github.com/repos/team/extension/releases/tags/v1.2');
  assert.equal(requests[1].url, 'https://api.github.com/repos/team/extension/releases/assets/42');
  assert.equal(requests[1].init.headers.get('accept'), 'application/octet-stream');
  assert.deepEqual(requests[1].init.network.credentialHeaders, ['authorization']);
});

test('Gitea release and attachment metadata use their download URL without forwarding tokens to other origins', async () => {
  for (const [url, metadataURL] of [
    ['https://git.example/forge/team/ext/releases/download/v1/package.zip', 'https://git.example/forge/api/v1/repos/team/ext/releases/tags/v1'],
    ['https://git.example/forge/api/v1/repos/team/ext/releases/3/assets/4', 'https://git.example/forge/api/v1/repos/team/ext/releases/3/assets/4'],
  ]) {
    const calls = [];
    await downloadExtensionPackage({ url, provider: 'gitea', apiBase: 'https://git.example/forge/api/v1',
      authentication: { type: 'token', token: 'gitea-private' }, headers: { 'X-Download-Key': 'second-private' } },
    { fetcher: async (target, init) => {
      calls.push(target);
      if (calls.length === 1) {
        assert.equal(target, metadataURL);
        assert.equal(init.headers.get('authorization'), 'token gitea-private');
        const asset = { name: 'package.zip', browser_download_url: 'https://storage.example/signed.zip?signature=public-signature' };
        return Response.json(target.includes('/tags/') ? { assets: [asset] } : asset);
      }
      assert.equal(init.headers.has('authorization'), false);
      assert.equal(init.headers.has('x-download-key'), false);
      return archive();
    } });
    assert.equal(calls.length, 2);
  }
});

test('GitLab private releases and generic packages retain project paths and the chosen token type', async () => {
  const release = await resolvePackageRequest({ url: 'https://git.example/group/subgroup/ext/-/releases/v2/downloads/packages/extension.zip',
    provider: 'gitlab', authentication: { type: 'token', token: 'project-private' } });
  assert.equal(release.url, 'https://git.example/api/v4/projects/group%2Fsubgroup%2Fext/releases/v2/downloads/packages/extension.zip');
  assert.equal(release.init.headers.get('private-token'), 'project-private');
  const url = 'https://git.example/api/v4/projects/7/packages/generic/ext/2/extension.zip';
  const registry = await resolvePackageRequest({ url, provider: 'gitlab', authentication: { type: 'header', name: 'DEPLOY-TOKEN', value: 'registry-private' } });
  assert.equal(registry.url, url); assert.equal(registry.init.headers.get('deploy-token'), 'registry-private');
  assert.equal(registry.init.headers.has('private-token'), false);
});

test('raw ZIP and source archive URLs resolve to the matching provider endpoint without replacing release assets', async () => {
  for (const [url, expected] of [
    ['https://raw.githubusercontent.com/team/ext/refs/heads/main/dist/package.zip', 'https://api.github.com/repos/team/ext/contents/dist/package.zip?ref=main'],
    ['https://github.com/team/ext/archive/refs/tags/v2.zip', 'https://api.github.com/repos/team/ext/zipball/v2'],
    ['https://gitlab.com/group/ext/-/raw/main/dist/package.zip', 'https://gitlab.com/api/v4/projects/group%2Fext/repository/files/dist%2Fpackage.zip/raw?ref=main'],
    ['https://gitlab.com/group/ext/-/archive/v2/ext-v2.zip', 'https://gitlab.com/api/v4/projects/group%2Fext/repository/archive.zip?sha=v2'],
  ]) assert.equal((await resolvePackageRequest({ url })).url, expected);
});

test('direct basic authentication supports Unicode and download errors never expose credentials', async () => {
  const entry = { url: 'https://packages.example/private.zip', authentication: { type: 'basic', username: 'agent', password: 'päss:private' } };
  const request = await resolvePackageRequest(entry);
  assert.equal(Buffer.from(request.init.headers.get('authorization').slice(6), 'base64').toString('utf8'), 'agent:päss:private');
  for (const fetcher of [async () => { throw new Error('päss:private'); }, async () => new Response('päss:private', { status: 401 }),
    async () => Response.json({ token: 'päss:private' }), async () => new Response('')]) {
    await assert.rejects(downloadExtensionPackage(entry, { fetcher }), error => error.code === 'PACKAGE_SOURCE_FAILED' && !error.message.includes('päss:private') && error.cause === undefined);
  }
});
