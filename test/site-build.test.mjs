import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySiteBuild, readSiteProfile, sourceBuildUrl, stageSiteShell } from '../scripts/site-build.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('compose the shipped fork example against a reusable engine in a project Pages path', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fork-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'dist');
  const siteDirectory = path.join(root, 'site');
  await mkdir(path.join(directory, 'src/locales'), { recursive: true });
  await mkdir(path.join(directory, 'assets'));
  await mkdir(path.join(root, 'deploys'));
  await cp(path.join(project, 'index.html'), path.join(root, 'index.html'));
  for (const file of ['schema.json', 'catalog.schema.json', 'document.schema.json']) {
    await cp(path.join(project, 'deploys', file), path.join(root, 'deploys', file));
  }
  const sampleCatalog = await json(path.join(project, 'examples/fork-site/deploys/catalog.json'));
  await writeFile(path.join(root, 'deploys/catalog.json'), JSON.stringify(sampleCatalog));
  await cp(path.join(project, 'examples/fork-site'), siteDirectory, { recursive: true });
  const engineCommit = '1'.repeat(40);
  const buildId = '2'.repeat(64);
  const sourceCommit = '3'.repeat(40);
  const upstream = { sourceCommit: engineCommit, buildId, runId: '100' };
  const manifest = { schemaVersion: 1, sourceCommit: engineCommit, deploys: { packages: [] }, deployment: { environment: 'production' },
    defaults: { phpVersion: '8.3', joomlaVersion: '6.2.0' }, php: ['8.3', '8.4'],
    joomla: [{ version: '6.2.0', php: ['8.3'] }, { version: '5.4.0', php: ['8.3', '8.4'] }] };
  await writeFile(path.join(directory, 'assets/manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(directory, 'assets/version-catalog.json'), '{}');
  await writeFile(path.join(directory, 'build.json'), JSON.stringify({ schemaVersion: 1, id: buildId }));
  await writeFile(path.join(directory, 'CNAME'), 'playground.joomengine.org\n');
  const canonicalUrl = 'https://extension.github.io/Field-Notes/';
  await applySiteBuild({ root, directory, siteDirectory, canonicalUrl, sourceCommit, upstream });
  const composed = await json(path.join(directory, 'assets/manifest.json'));
  assert.equal(composed.deployment.canonicalUrl, canonicalUrl);
  assert.deepEqual(composed.defaults, { joomlaVersion: '5.4.0', phpVersion: '8.4' });
  assert.deepEqual(composed.upstreamEngine, upstream);
  assert.equal(composed.sourceCommit, sourceCommit);
  assert.equal(composed.deploys.default, 'field-notes');
  assert.match(composed.site.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(readFile(path.join(directory, 'CNAME')), { code: 'ENOENT' });
  const html = await readFile(path.join(directory, 'index.html'), 'utf8');
  assert.ok(html.includes(`<link rel="canonical" href="${canonicalUrl}">`));
  assert.ok(html.includes('<title data-i18n="siteBrand.title">Field Notes editorial desk</title>'));
  assert.ok(html.includes('id="information-dialog"') && html.includes('Apache-2.0'));
  assert.equal(JSON.parse(html.match(/id="playground-site">([^<]+)</)[1]).features.deployments, false);
  const entries = await json(path.join(directory, 'asset-inventory.json'));
  assert.ok(entries.some(({ path }) => path === 'site/assets/field-notes.svg'));
  assert.notEqual((await json(path.join(directory, 'build.json'))).id, buildId);
});

test('the default shell stays byte-identical and project repository names retain their case', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stock-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDirectory = path.join(root, 'site');
  const profile = await readSiteProfile(siteDirectory);
  const canonicalUrl = await sourceBuildUrl({ root: project, profile, environment: {} });
  const environment = { GITHUB_REPOSITORY: 'Owner/My-Extension' };
  assert.equal(await sourceBuildUrl({ root: project, profile, environment }), 'https://owner.github.io/My-Extension/');
  assert.equal(await sourceBuildUrl({ root, profile, environment }), 'https://owner.github.io/My-Extension/');
  await writeFile(path.join(root, 'CNAME'), 'demo.example.org\n');
  assert.equal(await sourceBuildUrl({ root, profile, environment }), 'https://demo.example.org/');
  const original = await readFile(path.join(project, 'index.html'), 'utf8');
  await writeFile(path.join(root, 'index.html'), original);
  await stageSiteShell({ directory: root, siteDirectory, profile, manifest: { deployment: { canonicalUrl } } });
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), original);
  assert.equal((await readFile(path.join(root, 'CNAME'), 'utf8')).trim(), 'playground.joomengine.org');
});
