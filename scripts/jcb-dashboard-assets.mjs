import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const componentPath = 'component-builder/admin/assets/images/community/';
const renderedPath = 'components/com_componentbuilder/assets/images/community/';

/** Reviewed SVG snapshots may contain links, but cannot fetch other resources or run code. */
export function validateDashboardImage(bytes, mime, depth = 0) {
  assert.ok(depth <= 8 && bytes.byteLength <= 5 * 1024 * 1024, 'Dashboard artwork exceeds the reviewed image bounds.');
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0, 'Dashboard artwork must contain image bytes.');
  if (mime === 'image/svg+xml') {
    const svg = decode(bytes);
    assert.match(svg, /<svg\b/i, 'SVG artwork needs an SVG root.');
    assert.doesNotMatch(svg, /<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed|audio|video)\b|\bon[a-z]+\s*=|@import/i,
      'SVG artwork must be inert.');
    for (const tag of svg.matchAll(/<([\w:-]+)\b([^>]*)>/g)) {
      for (const attribute of tag[2].matchAll(/(?:^|\s)(?:xlink:)?(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) {
        const value = attribute[2];
        assert.doesNotMatch(value, /&|[\u0000-\u0020]/, 'SVG resource references must be explicit.');
        const embedded = /^data:(image\/(?:png|jpeg|gif|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(value);
        if (embedded) validateDashboardImage(new Uint8Array(Buffer.from(embedded[2], 'base64')), embedded[1], depth + 1);
        else assert.ok(/^#[\w:.-]+$/.test(value) || (tag[1].toLowerCase() === 'a' && /^https:\/\//.test(value)),
          'SVG artwork cannot embed external resources.');
      }
    }
    for (const reference of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      assert.match(reference[2], /^#[\w:.-]+$/, 'SVG styles cannot fetch external resources.');
    }
  } else if (mime === 'image/png') assert.equal(Buffer.from(bytes.subarray(0, 8)).toString('hex'), '89504e470d0a1a0a');
  else if (mime === 'image/jpeg') assert.equal(Buffer.from(bytes.subarray(0, 3)).toString('hex'), 'ffd8ff');
  else if (mime === 'image/gif') assert.match(Buffer.from(bytes.subarray(0, 6)).toString(), /^GIF8[79]a$/);
  else if (mime === 'image/webp') {
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF');
    assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), 'WEBP');
  } else throw new Error(`Unsupported dashboard artwork type: ${mime}`);
}

/** Keep JCB's artwork and credit links available inside a cross-origin-isolated site. */
export async function prepareJcbDashboardAssets(files, { root, version }) {
  const directory = path.join(root, 'dependencies/jcb-dashboard-assets');
  const manifestBytes = await readFile(path.join(directory, 'assets.json'));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 1);
  const source = manifest.sources[version];
  assert.ok(source, `JCB ${version} dashboard sources require review.`);
  const originals = {};
  for (const kind of ['readme', 'support', 'compiler']) {
    const pin = source[kind], bytes = files[pin.path];
    assert.ok(bytes instanceof Uint8Array && digest(bytes) === pin.sha256, `The JCB ${kind} differs from its reviewed source.`);
    originals[kind] = decode(bytes);
  }
  const prepared = { ...files }, byURL = new Map();
  prepared[componentPath + 'manifest.json'] = new Uint8Array(manifestBytes);
  prepared[componentPath + 'NOTICE.md'] = new Uint8Array(await readFile(path.join(directory, 'README.md')));
  for (const asset of manifest.assets) {
    assert.match(asset.file, /^assets\/[a-f0-9]{64}\.(?:svg|png|jpe?g|gif|webp)$/);
    assert.equal(path.basename(asset.file).split('.')[0], asset.sha256);
    assert.ok(!byURL.has(asset.url) && new URL(asset.url).protocol === 'https:');
    const bytes = new Uint8Array(await readFile(path.join(directory, asset.file)));
    assert.equal(bytes.byteLength, asset.size, `Dashboard artwork size differs for ${asset.url}.`);
    assert.equal(digest(bytes), asset.sha256, `Dashboard artwork checksum differs for ${asset.url}.`);
    validateDashboardImage(bytes, asset.mime);
    prepared[componentPath + path.basename(asset.file)] = bytes;
    byURL.set(asset.url, asset);
  }
  const used = new Set();
  const replace = (url, kind) => {
    const asset = byURL.get(url);
    assert.ok(asset?.usages.includes(kind), `The ${kind} image requires a reviewed snapshot: ${url}`);
    used.add(url);
    return renderedPath + path.basename(asset.file);
  };
  let readmeCount = 0, supportCount = 0;
  const readme = originals.readme.replace(/(!\[[^\]]*\]\()(https:\/\/[^)\s]+)((?:\s+"[^"\r\n]*")?\))/g, (_, before, url, after) => {
    readmeCount++; return before + replace(url, 'readme') + after;
  });
  const support = originals.support.replace(/(<img\b[^>]*\bsrc=["'])(https:\/\/[^"']+)(["'])/g, (_, before, url, after) => {
    supportCount++; return before + replace(url, 'support') + after;
  });
  assert.equal(readmeCount, 24, 'All original README community images must remain present.');
  assert.equal(supportCount, 5, 'All original support badges must remain present.');
  const avatarAssets = manifest.assets.filter(asset => asset.usages.includes('avatar'));
  assert.equal(avatarAssets.length, 1, 'The reviewed live-feed profile has one original avatar snapshot.');
  const avatar = avatarAssets[0];
  assert.match(avatar.profile.id, /^\d+$/);
  assert.equal(new URL(avatar.profile.url).origin, new URL(avatar.url).origin);
  const avatarPath = replace(avatar.url, 'avatar');
  const avatarAssignment = 'const avatar = user.avatar_static;';
  assert.equal(originals.compiler.split(avatarAssignment).length, 2, 'The reviewed feed avatar assignment must occur once.');
  const compiler = originals.compiler.replace(avatarAssignment,
    `const avatar = user.id === ${JSON.stringify(avatar.profile.id)} && user.url === ${JSON.stringify(avatar.profile.url)}\n        ? ${JSON.stringify(avatarPath)} : user.avatar_static;`);
  assert.equal(used.size, byURL.size, 'Every bundled dashboard image must be referenced.');
  prepared[source.readme.path] = new TextEncoder().encode(readme);
  prepared[source.support.path] = new TextEncoder().encode(support);
  prepared[source.compiler.path] = new TextEncoder().encode(compiler);
  return { files: prepared, provenance: { manifestSha256: digest(manifestBytes), retrievedAt: manifest.retrievedAt,
    sources: Object.fromEntries(['readme', 'support', 'compiler'].map(kind => [kind, { ...source[kind], patchedSha256: digest(prepared[source[kind].path]) }])),
    assets: manifest.assets.map(({ url, file, sha256, size, mime }) => ({ url, sha256, size, mime, installedPath: 'administrator/' + renderedPath + path.basename(file) })) } };
}
