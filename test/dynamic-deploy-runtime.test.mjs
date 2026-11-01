import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createShareURL, createFullDeploymentDocument, normalizeConfiguration, parseCatalog, readURLConfiguration } from '../src/config.mjs';
import { normalizeDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { verifyPackage, validateInstallOptions } from '../src/joomla/index.mjs';
import { customSetupDetails, isolateSetup, publicConfiguration } from '../src/ui-state.mjs';
import { deploymentNeedsReview } from '../src/launch-countdown.mjs';

const baseURL = 'https://playground.joomengine.org/';
const directory = new URL('../deploys/', import.meta.url);
const sourceCatalog = JSON.parse(await readFile(new URL('catalog.json', directory), 'utf8'));
const deployCatalog = normalizeDeployCatalog(sourceCatalog, { baseURL: `${baseURL}deploys/catalog.json` });
const files = new Map(await Promise.all(sourceCatalog.deploys.map(async ({ id }) => [`${baseURL}deploys/${id}.json`, await readFile(new URL(`${id}.json`, directory), 'utf8')])));
const fetcher = async (url) => new Response(files.get(String(url)) ?? '', { status: files.has(String(url)) ? 200 : 404 });
const catalog = parseCatalog({ php: [{ version: '8.3' }, { version: '8.4' }, { version: '8.5' }],
  joomla: [{ version: '5.4.10', php: ['8.3', '8.4'] }, { version: '6.2.0', php: ['8.3', '8.4', '8.5'] },
    { version: '7.0.0-alpha1-dev', php: ['8.3', '8.4'] }], defaults: { phpVersion: '8.4', joomlaVersion: '6.2.0' } });
const options = { catalog, deployCatalog, fetcher, baseURL };
const admin = { password: 'Deploy-contract-password-123!' };
const dynamicJcb = { url: 'https://example.org/pkg-component-builder-v6.2.1-alpha1.zip', sha512: 'a'.repeat(128) };

test('explicit JCB version changes replace only JCB and do not reuse the preset snapshot', async () => {
  const preset = JSON.parse(files.get(`${baseURL}deploys/jcb.json`));
  preset.snapshot = { format: 'joomengine-playground-export', schemaVersion: 1, joomlaVersion: '6.2.0', url: './prepared.zip', sha256: 'c'.repeat(64) };
  const withSnapshot = { ...options, fetcher: async (url) => String(url).endsWith('/jcb.json') ? new Response(JSON.stringify(preset)) : fetcher(url) };
  const pinned = (await resolveDeployConfiguration({ admin, deployId: 'jcb', jcbVersion: '6.2.0' }, withSnapshot)).configuration;
  assert.equal(pinned.snapshot.sha256, 'c'.repeat(64));
  assert.match(pinned.extensions[0].url, /v6\.2\.0\.zip$/);
  const replacedPinned = (await resolveDeployConfiguration({ admin, deployId: 'jcb', jcbVersion: '6.2.0', jcbPackage: dynamicJcb }, withSnapshot)).configuration;
  assert.deepEqual(replacedPinned.extensions, [dynamicJcb]);
  assert.equal(replacedPinned.snapshot, undefined);
  const alternate = (await resolveDeployConfiguration({ admin, deployId: 'jcb', jcbVersion: '6.2.1-alpha1', jcbPackage: dynamicJcb }, withSnapshot)).configuration;
  assert.deepEqual(alternate.extensions, [dynamicJcb]);
  assert.equal(alternate.snapshot, undefined);
  await assert.rejects(resolveDeployConfiguration({ admin, deployId: 'jcb', jcbVersion: 'none' }, withSnapshot), /requires Joomla Component Builder/);
  await assert.rejects(resolveDeployConfiguration({ admin, deployId: 'jcb', jcbVersion: '6.2.1-alpha1' }, options), /package is unavailable/);
});

test('other presets retain their package when adding JCB, including Joomla-only by explicit choice', async () => {
  for (const deployId of ['servicedirectory', 'blank']) {
    const result = (await resolveDeployConfiguration({ admin, deployId, jcbVersion: '6.2.1-alpha1', jcbPackage: dynamicJcb }, options)).configuration;
    assert.deepEqual(result.extensions[0], dynamicJcb);
    assert.equal(result.extensions.length, deployId === 'blank' ? 1 : 2);
    if (deployId !== 'blank') assert.match(result.extensions[1].url, /pkg-servicedirectory/);
  }
  await assert.rejects(resolveDeployConfiguration({ admin, deployId: 'blank', jcbVersion: '5.2.0', jcbPackage: dynamicJcb }, options), /not a selectable package/);
  const j7 = (await resolveDeployConfiguration({ admin, deployId: 'jcb', joomlaVersion: '7.0.0-alpha1-dev', jcbVersion: '6.2.1-alpha1', jcbPackage: dynamicJcb }, options)).configuration;
  assert.equal(j7.joomlaVersion, '7.0.0-alpha1-dev');
  assert.deepEqual(j7.extensions, [dynamicJcb]);
  for (const deployId of ['jcb-mcp', 'servicedirectory', 'patchtester', 'weblinks', 'heritage-demo']) {
    await assert.rejects(resolveDeployConfiguration({ admin, deployId, joomlaVersion: '7.0.0-alpha1-dev', jcbVersion: '6.2.1-alpha1', jcbPackage: dynamicJcb }, options), /not available for Joomla 7/);
  }
});

test('Service Directory and heritage accept None or the shared pinned JCB without missing-package errors', async () => {
  for (const deployId of ['servicedirectory', 'heritage-demo']) {
    const plain = (await resolveDeployConfiguration({ admin, deployId, jcbVersion: 'none' }, options)).configuration;
    assert.equal(plain.extensions.some(entry => entry.url.includes('component-builder')), false);
    const added = (await resolveDeployConfiguration({ admin, deployId, jcbVersion: '6.2.0' }, options)).configuration;
    assert.match(added.extensions[0].url, /v6\.2\.0\.zip$/);
    assert.equal(added.extensions.length, plain.extensions.length + 1);
  }
});

test('a complete custom recipe replaces removed core packages and commands without restoring hidden defaults', async () => {
  const original = (await resolveDeployConfiguration({ admin, deployId: 'servicedirectory', jcbVersion: 'none' }, options)).configuration;
  const recipe = createFullDeploymentDocument(original, { name: 'Directory Custom', requirements: { joomla: ['5', '6'], jcb: 'optional' }, baseURL });
  const removed = await resolveDeployConfiguration({ admin, deployId: 'custom-directory', deploymentRecipe: recipe, extensions: [], startupCommands: [], initialPath: '/' }, options);
  assert.deepEqual(removed.configuration.extensions, []);
  assert.deepEqual(removed.configuration.startupCommands, []);
  assert.equal(removed.configuration.snapshot, undefined);
  assert.equal(removed.deploy.title, 'Directory Custom');
  const retained = (await resolveDeployConfiguration({ admin, deployId: 'custom-directory', deploymentRecipe: recipe }, options)).configuration;
  assert.deepEqual(retained.extensions, original.extensions);
  assert.deepEqual(retained.addonExtensions, []);
  const edited = (await resolveDeployConfiguration({ admin, deployId: 'custom-directory', deploymentRecipe: recipe,
    extensions: [{ ...original.extensions[0], sha256: 'not-a-digest' }, { url: 'https://example.test/custom.zip', sha512: 'invalid' }] }, options)).configuration;
  assert.deepEqual(edited.extensions, [{ url: original.extensions[0].url }, { url: 'https://example.test/custom.zip' }]);
  assert.deepEqual(edited.addonExtensions, edited.extensions);
});

test('a custom JCB opening page still requires JCB and can select another compatible package', async () => {
  const original = (await resolveDeployConfiguration({ admin, deployId: 'jcb', jcbVersion: '6.2.0' }, options)).configuration;
  const recipe = createFullDeploymentDocument(original, { name: 'JCB Custom', requirements: { joomla: ['6'], jcb: 'optional' }, baseURL });
  await assert.rejects(resolveDeployConfiguration({ admin, deployId: 'custom-jcb', deploymentRecipe: recipe, jcbVersion: 'none' }, options), /requires Joomla Component Builder/);
  const selected = (await resolveDeployConfiguration({ admin, deployId: 'custom-jcb', deploymentRecipe: recipe, jcbVersion: '6.2.1-alpha1', jcbPackage: dynamicJcb }, options)).configuration;
  assert.deepEqual(selected.extensions, [dynamicJcb]);
  assert.deepEqual(selected.addonExtensions, []);
  assert.equal(selected.snapshot, undefined);
});

test('custom recipes switch unchanged managed variant packages with the selected Joomla major', async () => {
  const original = (await resolveDeployConfiguration({ admin, deployId: 'servicedirectory', joomlaVersion: '5.4.10', jcbVersion: 'none' }, options)).configuration;
  const recipe = createFullDeploymentDocument(original, { name: 'Directory Custom', requirements: { joomla: ['5', '6'], jcb: 'optional' }, baseURL });
  const switched = (await resolveDeployConfiguration({ admin, deployId: 'custom-directory', deploymentRecipe: recipe, joomlaVersion: '6.2.0' }, options)).configuration;
  const expected = (await resolveDeployConfiguration({ admin, deployId: 'servicedirectory', joomlaVersion: '6.2.0', jcbVersion: 'none' }, options)).configuration;
  assert.deepEqual(switched.extensions, expected.extensions);
  assert.notDeepEqual(switched.extensions, original.extensions);
  assert.deepEqual(switched.addonExtensions, []);
});

test('imported provenance cannot turn an arbitrary extension into a managed core package', async () => {
  const recipe = createFullDeploymentDocument({ admin, deployId: 'servicedirectory', sourceDeployId: 'servicedirectory', joomlaVersion: '6.2.0', phpVersion: '8.4',
    extensions: [{ url: 'https://example.test/custom.zip', sha256: 'a'.repeat(64) }], addonExtensions: [] },
  { name: 'Imported Custom', requirements: { joomla: ['6'], jcb: 'optional' }, baseURL });
  const selected = (await resolveDeployConfiguration({ admin, deployId: 'custom-import', deploymentRecipe: recipe }, options)).configuration;
  assert.deepEqual(selected.extensions, [{ url: 'https://example.test/custom.zip' }]);
  assert.deepEqual(selected.addonExtensions, selected.extensions);
});

test('versioned packages survive public configuration and share links with their checksums', async () => {
  const joomlaPackage = { url: 'https://example.org/joomla-full.zip', sha256: 'b'.repeat(64), php: ['8.3', '8.4'] };
  const config = normalizeConfiguration({ admin, deployId: 'jcb', joomlaVersion: '7.0.0-alpha1-dev', joomlaPackage, jcbVersion: '6.2.1-alpha1', jcbPackage: dynamicJcb }, { catalog, baseURL });
  const result = readURLConfiguration(createShareURL(baseURL, config)).config;
  assert.deepEqual(result.joomlaPackage, joomlaPackage);
  assert.deepEqual(result.jcbPackage, dynamicJcb);
  assert.equal(result.jcbVersion, '6.2.1-alpha1');
  const saved = publicConfiguration({ ...config, extensions: [dynamicJcb] });
  assert.equal(saved.extensions[0].sha512, dynamicJcb.sha512);
  const existing = { ...saved, storageKey: 'same-site', jcbVersion: '6.2.0', jcbPackage: undefined };
  const isolated = await isolateSetup({ sites: { 'same-site': existing } }, { ...saved, storageKey: 'same-site' });
  assert.equal(isolated.changed, true);
  assert.notEqual(isolated.configuration.storageKey, 'same-site');
  assert.equal(validateInstallOptions(config).joomlaVersion, '7.0.0-alpha1-dev');
});

test('SHA-512 is verified before installation and cannot silently replace SHA-256 validation', async () => {
  const bytes = Uint8Array.of(0x50, 0x4b, 3, 4, 1, 2, 3);
  const sha512 = [...new Uint8Array(await crypto.subtle.digest('SHA-512', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  assert.deepEqual(await verifyPackage(bytes, undefined, sha512), bytes);
  await assert.rejects(verifyPackage(bytes, undefined, '0'.repeat(128)), /SHA-512 verification failed/);
  await assert.rejects(verifyPackage(bytes, '0'.repeat(64), sha512), /SHA-256 verification failed/);
});

test('shared dynamic packages require review and any source or digest change invalidates the reviewed identity', () => {
  const joomlaPackage = { url: 'https://example.org/joomla.zip', sha256: 'b'.repeat(64), php: ['8.3', '8.4'] };
  const setup = { joomlaVersion: '7.0.0-alpha1-dev', joomlaPackage, jcbVersion: '6.2.1-alpha1', jcbPackage: dynamicJcb };
  assert.equal(deploymentNeedsReview({ joomlaPackage }), true);
  assert.equal(deploymentNeedsReview({ jcbPackage: dynamicJcb }), true);
  const reviewed = customSetupDetails(setup);
  assert.deepEqual(reviewed.sources, [joomlaPackage.url, dynamicJcb.url]);
  assert.notEqual(JSON.stringify(reviewed), JSON.stringify(customSetupDetails({ ...setup, joomlaPackage: { ...joomlaPackage, sha256: 'c'.repeat(64) } })));
  assert.notEqual(JSON.stringify(reviewed), JSON.stringify(customSetupDetails({ ...setup, jcbPackage: { ...dynamicJcb, url: 'https://example.org/other.zip' } })));
  assert.notEqual(JSON.stringify(reviewed), JSON.stringify(customSetupDetails({ ...setup, jcbVersion: '6.2.2' })));
  reviewed.joomlaPackage.php.pop();
  assert.equal(joomlaPackage.php.length, 2);
});

test('first-time shared launches and saved resumes resolve pinned dynamic Joomla releases without live discovery', async () => {
  const pinnedOnly = { ...catalog, joomla: catalog.joomla.filter(entry => entry.version !== '7.0.0-alpha1-dev') };
  const joomlaPackage = { url: 'https://example.org/joomla-full.zip', sha256: 'd'.repeat(64), php: ['8.3', '8.4'] };
  const requested = { admin, deployId: 'blank', joomlaVersion: '7.0.0-alpha1-dev', joomlaPackage,
    phpVersion: '8.4', jcbVersion: 'none', storageKey: 'saved-seven', persistence: true };
  const shared = readURLConfiguration(createShareURL(baseURL, requested)).config;
  assert.equal(deploymentNeedsReview(shared), true, 'Shared executable source requires explicit review.');
  const firstLaunch = await resolveDeployConfiguration({ ...shared, admin }, { ...options, catalog: pinnedOnly });
  assert.equal(firstLaunch.configuration.joomlaVersion, '7.0.0-alpha1-dev');
  assert.deepEqual(firstLaunch.configuration.joomlaPackage, joomlaPackage);
  const saved = publicConfiguration(requested);
  const reopened = await resolveDeployConfiguration({ ...saved, admin }, { ...options, catalog: pinnedOnly });
  assert.equal(reopened.configuration.storageKey, 'saved-seven');
  assert.deepEqual(reopened.configuration.joomlaPackage, joomlaPackage);
  assert.equal(reopened.configuration.phpVersion, '8.4');
  await assert.rejects(resolveDeployConfiguration({ ...requested, phpVersion: '8.5' }, { ...options, catalog: pinnedOnly }), /PHP and Joomla combination|does not support/);
  await assert.rejects(resolveDeployConfiguration({ ...requested, joomlaPackage: { ...joomlaPackage, php: ['8.4', '7.4'] } }, { ...options, catalog: pinnedOnly }), /PHP 7\.4 is not available/);
  await assert.rejects(resolveDeployConfiguration({ ...requested, joomlaVersion: '6.2.0', joomlaPackage: { ...joomlaPackage, php: ['8.4', '9.9'] } }, { ...options, catalog: pinnedOnly }), /PHP 9\.9 is not available/);
  await assert.rejects(resolveDeployConfiguration({ ...requested, joomlaPackage: { ...joomlaPackage, sha256: undefined } }, { ...options, catalog: pinnedOnly }), /SHA-256/);
});
