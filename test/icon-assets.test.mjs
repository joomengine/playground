import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ACTION_ICONS } from '../src/icon-data.mjs';
import { ICON_IDS, DERIVED_ICON_IDS, iconMarkup } from '../src/icons.mjs';

const brand = new URL('../src/brand/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const compact = value => value.replace(/>\s+</g, '><').trim();

test('every shipped action preserves its supplied source geometry and transparent bounds', async () => {
  const manifest = JSON.parse(await readFile(new URL('icons/icon-manifest.json', brand), 'utf8'));
  assert.equal(ICON_IDS.length, manifest.icons.length + DERIVED_ICON_IDS.length);
  for (const entry of manifest.icons.filter(item => item.files.currentColor)) {
    const source = await readFile(new URL(`icons/originals/${entry.source_path}`, brand), 'utf8');
    assert.equal(hash(source), entry.source_sha256, entry.id);
    assert.equal(ACTION_ICONS[entry.id], compact(source.replace(/<svg\b([^>]*)>/, '<svg$1 fill="currentColor">')), entry.id);
    const decorated = iconMarkup(entry.id);
    assert.match(decorated, /aria-hidden="true"/);
    assert.match(decorated, /focusable="false"/);
    assert.doesNotMatch(decorated, /<script|\son\w+=|https?:\/\/(?!www\.w3\.org)/i);
  }
  assert.throws(() => iconMarkup('untrusted.svg'), /Unknown/);
});

test('pearl SVG framing retains every path, gradient and color with an unchanged master', async () => {
  const manifest = JSON.parse(await readFile(new URL('brand-manifest.json', brand), 'utf8'));
  const source = await readFile(new URL('JoomEngine_Pearl_Logo.original.svg', brand), 'utf8');
  assert.equal(hash(source), manifest.sha256);
  const body = svg => compact(svg.slice(svg.indexOf('>') + 1).replace(/^<svg[^>]+>/, ''));
  const sourceBody = body(source.replace(/<\?xml[^>]*\?>\s*/, ''));
  for (const name of ['rocket.svg', 'favicon.svg']) {
    const generated = await readFile(new URL(name, brand), 'utf8');
    assert.equal(body(generated), sourceBody, name);
    assert.ok(generated.includes(`viewBox="${manifest.normalized_viewBox}"`));
    assert.match(generated, /preserveAspectRatio="xMidYMid meet"/);
    assert.ok(generated.length < source.length);
  }
});

// Site upload and download remain one visual pair without changing editor uploads.
test('site upload reverses only the download arrow and retains its tray', () => {
  const download = iconMarkup('download-site');
  const upload = iconMarkup('upload-site');
  assert.equal(upload, download.replace('M13 10h5l-6 6-6-6h5V3h2v7z', 'M13 9h5l-6-6-6 6h5v7h2V9z'));
  assert.notEqual(upload, download);
  assert.notEqual(upload, iconMarkup('upload-files'));
});
