import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog, createFullDeploymentDocument } from '../src/config.mjs';
import { normalizeDeploy, normalizeDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { deploymentLaunchReadiness } from '../src/launch-readiness.mjs';

const baseURL = 'https://playground.example/';
const release = '6.2.0';
const admin = { password: 'Readiness-contract-password-123!' };
const snapshot = { format: 'joomengine-playground-export', schemaVersion: 1, joomlaVersion: release,
  url: `${baseURL}assets/snapshots/prepared.zip`, sha256: 'a'.repeat(64) };
const language = { tag: 'nl-NL', url: 'https://packages.example/nl.zip', sha256: 'b'.repeat(64) };
const recipe = { schemaVersion: 1, id: 'prepared', title: 'Prepared deployment', joomla: ['6'],
  configuration: { siteName: 'Prepared site' }, snapshot };
const catalog = parseCatalog({ php: [{ version: '8.3' }, { version: '8.4' }, { version: '8.5' }],
  joomla: [{ version: release, php: ['8.3', '8.4', '8.5'] }, { version: '6.2.1', php: ['8.3', '8.4', '8.5'] }],
  defaults: { phpVersion: '8.4', joomlaVersion: release } });
const deployCatalog = normalizeDeployCatalog({ schemaVersion: 1, default: 'prepared',
  deploys: [{ id: 'prepared', title: recipe.title, file: './prepared.json', joomla: ['6'] }],
  languages: { 6: [language] } }, { baseURL: `${baseURL}deploys/catalog.json` });
const manifest = { prebuiltDeploys: [{ id: 'prepared', joomlaVersion: release,
  url: snapshot.url, sha256: snapshot.sha256, size: 100 }] };
const requests = [];
const fetcher = async url => {
  requests.push(String(url));
  assert.equal(String(url), `${baseURL}deploys/prepared.json`, 'Readiness may only read small recipe metadata.');
  return Response.json(recipe);
};
const options = { baseURL, catalog, deployCatalog, manifest, fetcher };
const input = { deployId: 'prepared', admin };

test('maintained snapshot matching follows the real resolver and restores fast after changes', async () => {
  requests.length = 0;
  assert.equal(await deploymentLaunchReadiness(input, options), 'fast');
  assert.equal(await deploymentLaunchReadiness({ ...input, joomlaVersion: '6.2.1' }, options), 'fresh');
  assert.equal(await deploymentLaunchReadiness(input, options), 'fast');
  assert.equal(await deploymentLaunchReadiness({ ...input, fresh: true }, options), 'fresh');
  assert.equal(await deploymentLaunchReadiness(input, options), 'fast');
  assert.ok(requests.length);
  assert.equal(new Set(requests).size, 1);
});

test('compatible PHP and personalization retain the prepared base', async () => {
  assert.equal(await deploymentLaunchReadiness({ ...input, phpVersion: '8.5',
    siteName: 'My site', admin: { ...admin, username: 'another-admin' },
    initialPath: '/administrator/', autoLogin: false, persistence: false,
    phpSettings: { memory_limit: '768M' } }, options), 'fast');
  // The app reuses already loaded, normalized metadata for its current preset.
  assert.equal(await deploymentLaunchReadiness(input, { ...options,
    fetcher: async () => Response.json(normalizeDeploy(recipe, { baseURL })) }), 'fast');
});

test('extensions, commands, templates and extra languages describe additional setup', async () => {
  for (const additions of [
    { extensions: [{ url: 'https://packages.example/extra.zip' }] },
    { startupCommands: [['cache:clean']] },
    { template: { url: 'https://packages.example/template.zip', element: 'custom' } },
    { languages: [language] },
    { language: language.tag },
    { languageTags: [language.tag] },
  ]) assert.equal(await deploymentLaunchReadiness({ ...input, ...additions }, options), 'additional');
  assert.equal(await deploymentLaunchReadiness(input, options), 'fast');
});

test('published identity is authoritative and changed full recipes require installation', async () => {
  assert.equal(await deploymentLaunchReadiness(input, { ...options, manifest: { prebuiltDeploys: [] } }), 'fresh');
  const changed = { prebuiltDeploys: [{ ...manifest.prebuiltDeploys[0], url: `${baseURL}assets/snapshots/other.zip` }] };
  assert.equal(await deploymentLaunchReadiness(input, { ...options, manifest: changed }), 'fresh');
  const { configuration } = await resolveDeployConfiguration(input, options);
  const deploymentRecipe = createFullDeploymentDocument(configuration, { name: 'Custom deployment', baseURL,
    requirements: { joomla: ['6'] } });
  assert.equal(await deploymentLaunchReadiness({ ...input, deploymentRecipe }, options), 'fresh');
});

test('unavailable metadata and restored sites stay neutral; invalid settings never promise a fast start', async () => {
  assert.equal(await deploymentLaunchReadiness(input, { ...options, manifest: undefined }), null);
  assert.equal(await deploymentLaunchReadiness(input, { ...options, catalog: undefined }), null);
  assert.equal(await deploymentLaunchReadiness({ ...input, restoredSite: true }, options), null);
  await assert.rejects(deploymentLaunchReadiness({ ...input, phpVersion: 'invalid' }, options));
  await assert.rejects(deploymentLaunchReadiness(input, { ...options,
    fetcher: async () => new Response('', { status: 503 }) }));
});
