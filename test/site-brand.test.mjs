import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageSiteBrand } from '../scripts/site-brand.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'playground-brand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'dist');
  const siteDirectory = path.join(root, 'site');
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await mkdir(path.join(siteDirectory, 'assets'), { recursive: true });
  await cp(new URL('../index.html', import.meta.url), path.join(directory, 'index.html'));
  await cp(new URL('../src/locales/', import.meta.url), path.join(directory, 'src/locales'), { recursive: true });
  return { directory, siteDirectory };
}

test('a site with no brand settings retains the stock shell', async t => {
  const fixturePaths = await fixture(t);
  await stageSiteBrand({ ...fixturePaths, profile: {} });
  assert.equal(await readFile(path.join(fixturePaths.directory, 'index.html'), 'utf8'),
    await readFile(new URL('../index.html', import.meta.url), 'utf8'));
});

test('a custom site gets local assets, theme and translated text without changing About credits', async t => {
  const { directory, siteDirectory } = await fixture(t);
  for (const name of ['dark.svg', 'light logo.svg']) await writeFile(path.join(siteDirectory, 'assets', name), '<svg/>');
  await writeFile(path.join(siteDirectory, 'theme.css'), '.brand { padding: 1em }');
  const profile = { brand: {
    name: 'Field & Notes', logo: { dark: 'assets/dark.svg', light: 'assets/light logo.svg' }, favicon: 'assets/dark.svg',
    footer: { prefix: '©', company: 'Publishers', url: 'https://example.org/', credit: '<writers>' },
    links: { repository: 'https://github.com/example/playground' },
    colors: { light: { 'button-bg': '#fdf' }, dark: { canvas: '#222222' } },
    translations: { de: { name: 'Feldnotizen', footer: { company: 'Verlag' } } },
  } };
  await stageSiteBrand({ directory, siteDirectory, profile });
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  assert.match(html, /<title data-i18n="siteBrand.title">Field &amp; Notes<\/title>/);
  assert.match(html, /href="\.\/site\/assets\/dark\.svg"/);
  assert.match(html, /src="\.\/site\/assets\/dark\.svg"/);
  assert.match(html, /href="https:\/\/github.com\/example\/playground\/fork"/);
  assert.match(html, /&lt;writers&gt;/);
  assert.ok(html.indexOf('./site/theme.css') > html.indexOf('./site/brand.css'));
  const original = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const credits = /<dialog id="information-dialog"[\s\S]*?<\/dialog>/;
  assert.equal(html.match(credits)[0], original.match(credits)[0]);
  const css = await readFile(path.join(directory, 'site/brand.css'), 'utf8');
  assert.ok(css.includes('url("assets/light%20logo.svg")'));
  assert.ok(css.includes('--button-bg:#fdf'));
  const messages = (await import(pathToFileURL(path.join(directory, 'src/locales/de.mjs')))).default;
  assert.equal(messages['app.name'], 'Feldnotizen');
  assert.equal(messages['siteBrand.title'], 'Feldnotizen');
  assert.equal(messages['siteBrand.footer.company'], 'Verlag');
  assert.equal(messages['siteBrand.footer.credit'], '<writers>');
  assert.equal(messages['footer.affiliation'], (await import('../src/locales/de.mjs')).default['footer.affiliation']);
});

test('a renamed site can use a text wordmark, and unsupported credit overrides fail', async t => {
  const paths = await fixture(t);
  await assert.rejects(stageSiteBrand({ ...paths, profile: { brand: { credits: [] } } }), /Unknown brand field/);
  await assert.rejects(stageSiteBrand({ ...paths, profile: { brand: { translations: { en: { 'footer.affiliation': '' } } } } }), /Unknown/);
  await assert.rejects(stageSiteBrand({ ...paths, profile: { brand: { logo: 'assets/../private.svg' } } }), /under site\/assets/);
  await stageSiteBrand({ ...paths, profile: { brand: { name: 'Workshop' } } });
  const html = await readFile(path.join(paths.directory, 'index.html'), 'utf8');
  assert.ok(html.includes('<strong data-i18n="app.name">Workshop</strong>'));
  assert.ok(!html.includes('class="brand-product"'));
  assert.ok(html.includes('<title data-i18n="siteBrand.title">Workshop</title>'));
});

test('publishing assets rejects a link out of the site directory', async t => {
  const paths = await fixture(t);
  await symlink(path.join(paths.directory, 'index.html'), path.join(paths.siteDirectory, 'assets/link.svg'));
  await assert.rejects(stageSiteBrand({ ...paths, profile: {} }), /regular site branding files/);
});
