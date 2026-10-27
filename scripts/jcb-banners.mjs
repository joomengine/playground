import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { downloadVerified } from './assets.mjs';

const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const HELPER = 'component-builder/admin/src/Helper/ComponentbuilderHelper.php';
const BANNER_PATH = 'component-builder/admin/assets/images/banner/';
const INSTALLED_PATH = 'administrator/components/com_componentbuilder/assets/images/banner/';
const HELPERS = Object.freeze({
  '5.2.0': { sha256: '90bf45f811d9353a25d3496e4f0bda91ac189f3269e4884fea82f3e949e91a10', patchedSha256: 'e90fe8223d569d33a1a212111192f17114c948030c35c075e36196df75cc65c2' },
  '6.2.0': { sha256: 'c4128fa6b8546d014f0431cc7564e3f6857d7a73e0f531724ce4e9121f27ba11', patchedSha256: '950843f9be699f9b93a49e4df8079d9029fd47005a35e6111dbd64db17172e2c' },
});

export function correctJcbBannerReference(bytes, version) {
  const pin = HELPERS[version];
  if (!pin || !(bytes instanceof Uint8Array) || digest(bytes) !== pin.sha256) throw new Error('The JCB banner helper differs from its reviewed source.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const target = 'JCM_2010_728x90.png';
  assert.equal(source.split(target).length, 2, 'The reviewed wide magazine banner must appear exactly once.');
  const index = source.indexOf(target);
  const start = source.lastIndexOf("'url' => ", index);
  const end = source.indexOf("</a>']", index) + "</a>']".length;
  const block = source.slice(start, end);
  assert.equal(block.split('JCM_2010_120x600.png').length, 2);
  assert.equal(block.split('5389cf3be8569cb3f6793e8bd4013d19').length, 2);
  const corrected = block.replace('JCM_2010_120x600.png', target)
    .replace('5389cf3be8569cb3f6793e8bd4013d19', '4083c66f996279fd5a76adffc3a7d194');
  const result = new TextEncoder().encode(source.slice(0, start) + corrected + source.slice(end));
  assert.equal(digest(result), pin.patchedSha256, 'The JCB banner correction differs from its reviewed result.');
  return result;
}

/** Include the unchanged artwork referenced by every available sponsor banner. */
export async function prepareJcbBanners(files, { root, cache, version }) {
  const manifestBytes = await readFile(path.join(root, 'dependencies/jcb-banners/assets.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.assets.length, 7);
  assert.match(manifest.source.commit, /^[a-f0-9]{40}$/);
  const result = { ...files, [HELPER]: correctJcbBannerReference(files[HELPER], version) };
  const helper = new TextDecoder().decode(result[HELPER]);
  const start = helper.indexOf("'banner' => [");
  const end = helper.indexOf("'builder-gif' => [", start);
  const banners = helper.slice(start, end);
  const references = [...banners.matchAll(/'url' => '([^']+)',\s*'hash' => '([a-f0-9]{32})',\s*'html' => '([^']+)'/g)];
  assert.equal(references.length, 7, 'The helper must retain all seven sponsor banner choices.');
  const used = new Set();
  const assets = [];
  for (const [, url, md5, html] of references) {
    const name = new URL(url).pathname.split('/').at(-1);
    const pin = manifest.assets.find(asset => asset.name === name);
    assert.ok(pin && /^[a-zA-Z0-9_.-]+\.(?:png|gif)$/.test(name) && !used.has(name), 'Every sponsor banner must have a unique reviewed asset.');
    assert.equal(pin.md5, md5, `The banner checksum in the helper differs for ${name}.`);
    assert.ok(html.includes(`src="[[[ROOT-URL]]]${INSTALLED_PATH}${name}"`), `The banner download and image reference differ for ${name}.`);
    assert.equal(pin.url, `https://raw.githubusercontent.com/vdm-io/jcb-external/${manifest.source.commit}/src/images/banner/${name}`);
    const downloaded = await downloadVerified(pin.url, pin.sha256, path.join(cache, 'jcb-banners', `${pin.sha256}.${name.split('.').at(-1)}`));
    const bytes = new Uint8Array(await readFile(downloaded));
    assert.equal(bytes.byteLength, pin.size);
    assert.equal(digest(bytes, 'md5'), md5, `The bundled banner does not match JCB's content check: ${name}.`);
    result[`${BANNER_PATH}${name}`] = bytes;
    used.add(name);
    assets.push({ ...pin, path: `${BANNER_PATH}${name}`, installedPath: `${INSTALLED_PATH}${name}` });
  }
  return { files: result, provenance: { source: manifest.source, manifestSha256: digest(manifestBytes),
    helper: { path: HELPER, ...HELPERS[version] }, assets } };
}
