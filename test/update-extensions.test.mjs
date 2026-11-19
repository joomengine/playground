import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { updateExtensions, githubExtensionRelease } from '../scripts/update-extensions.mjs';

const zip = Buffer.from('504b0304ff', 'hex');
const digest = algorithm => createHash(algorithm).update(zip).digest('hex');
function release(id, version) {
  const name = id === 'weblinks' ? `pkg-weblinks-${version}.zip` : `com_patchtester_${version}.zip`;
  return { tag_name: version, draft: false, prerelease: false, assets: [{ name, digest: 'sha256:' + digest('sha256'),
    browser_download_url: `https://github.com/joomla-extensions/${id}/releases/download/${version}/${name}` }] };
}

test('GitHub extension releases require an exact official ZIP, stable tag and published digest', () => {
  for (const field of ['prerelease', 'draft']) assert.throws(() => githubExtensionRelease('weblinks', { ...release('weblinks', '5.2.1'), [field]: true }));
  const item = release('weblinks', '5.2.1');
  assert.equal(githubExtensionRelease('weblinks', item).sha256, digest('sha256'));
  for (const asset of [{ digest: null }, { browser_download_url: 'https://example.invalid/pkg-weblinks-5.2.1.zip' }]) {
    assert.throws(() => githubExtensionRelease('weblinks', { ...item, assets: [{ ...item.assets[0], ...asset }] }), /checksummed/);
  }
});

test('refresh updates both JCB recipes together, skips previews and keeps post-tag Service Directory fixes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'playground-extensions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'deploys');
  await mkdir(directory);
  await writeFile(path.join(root, 'versions.json'), '{}');
  const pin = url => ({ url, sha256: '1'.repeat(64) });
  const jcbPin = major => pin(`https://github.com/joomengine/pkg-component-builder/archive/refs/tags/v${major}.1.0.zip`);
  const directoryPin = major => pin(`https://codeload.github.com/joomengine/pkg-servicedirectory/zip/${major.repeat(40)}`);
  const recipes = {
    jcb: { variants: { 5: { extensions: [jcbPin('5')] }, 6: { extensions: [jcbPin('6')] } } },
    'jcb-mcp': { variants: { 6: { extensions: [jcbPin('6'), pin('https://codeload.github.com/joomengine/mcp_package/zip/refs/tags/v1.0.1')] } } },
    servicedirectory: { variants: { 5: { extensions: [directoryPin('5')] }, 6: { extensions: [directoryPin('6')] } } },
    patchtester: { configuration: { extensions: [pin(release('patchtester', '5.0.0').assets[0].browser_download_url)] } },
    weblinks: { configuration: { extensions: [pin(release('weblinks', '5.0.0').assets[0].browser_download_url)] } },
  };
  for (const [id, value] of Object.entries(recipes)) await writeFile(path.join(directory, `${id}.json`), JSON.stringify(value));
  const recipe = async id => JSON.parse(await readFile(path.join(root, `deploys/${id}.json`), 'utf8'));
  const originalService = await recipe('servicedirectory');
  let downloads = 0;
  let checksum = digest('sha512');
  const token = 'fixture-token';
  async function fetchImpl(value, init = {}) {
    const url = new URL(value);
    const auth = new Headers(init.headers).get('Authorization');
    if (url.origin === 'https://api.github.com') {
      assert.equal(auth, `Bearer ${token}`);
      assert.equal(init.redirect, 'error');
      const id = url.pathname.split('/')[3];
      return Response.json(release(id, '20.0.1'));
    }
    assert.equal(auth, null);
    if (url.origin === 'https://github.com') { downloads++; return new Response(zip); }
    assert.equal(url.origin, 'https://raw.githubusercontent.com');
    if (url.pathname.endsWith('pkg_servicedirectory.xml')) {
      const major = url.pathname.split('/')[3][0];
      return new Response(`<extension><version>${major}.0.4</version></extension>`);
    }
    const major = url.pathname.match(/\/(\d+)\.x\//)?.[1];
    const service = url.pathname.includes('Joomla-Service-Directory');
    const mcp = url.pathname.includes('/mcp_package/');
    const repository = service ? 'pkg-servicedirectory' : mcp ? 'mcp_package' : 'pkg-component-builder';
    const element = service ? 'pkg_servicedirectory' : mcp ? 'pkg_joomengine_mcp' : 'pkg_component_builder';
    const version = service && major === '5' ? '5.0.4' : `${major || '1'}.99.1`;
    const records = [version, version + '-alpha2'].map(tag => `<update><element>${element}</element><version>${tag}</version><downloadurl>https://github.com/joomengine/${repository}/archive/refs/tags/v${tag}.zip</downloadurl><sha512>${checksum}</sha512></update>`);
    return new Response(`<updates>${records.join('')}</updates>`);
  }
  const options = { root, fetchImpl, token };
  checksum = 'f'.repeat(128);
  await assert.rejects(updateExtensions(options), /checksum/);
  assert.deepEqual(await recipe('servicedirectory'), originalService);
  checksum = digest('sha512');
  assert.deepEqual(await updateExtensions(options), ['jcb', 'jcb-mcp', 'patchtester', 'servicedirectory', 'weblinks']);
  const jcb = (await recipe('jcb')).variants['6'].extensions[0];
  assert.deepEqual((await recipe('jcb-mcp')).variants['6'].extensions[0], jcb);
  assert.match(jcb.url, /\/v6\.99\.1\.zip$/);
  assert.equal(jcb.sha256, digest('sha256'));
  assert.equal(jcb.sha512, digest('sha512'));
  assert.deepEqual((await recipe('servicedirectory')).variants['5'], originalService.variants['5']);
  const retired = JSON.parse(await readFile(path.join(root, 'versions.json'))).retiredJcb;
  assert.deepEqual(retired, ['5','6'].map(major => ({ version: `${major}.1.0`, package: jcbPin(major) })));
  const count = downloads;
  assert.deepEqual(await updateExtensions(options), []);
  assert.equal(downloads, count, 'Unchanged package checksums require no new ZIP transfers.');
});
