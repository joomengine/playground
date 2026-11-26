import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { downloadVerified, hashFile } from './assets.mjs';
import { normalizeDeploy, normalizeDeployCatalog } from '../src/deploys.mjs';
import { pinnedJcbPackages } from '../src/jcb-selection.mjs';
import { prepareLanguagePackage } from './language-packages.mjs';

async function optionalJSON(directory, name) {
  if (!directory) return undefined;
  try { return JSON.parse(await readFile(path.join(directory, name), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Stage verified repository recipes and their packages on the playground origin. */
export async function stageDeployCatalog({ root, staging, assets, cache, canonicalUrl, siteDirectory, seedPackages = [] }) {
  const source = path.join(root, 'deploys');
  const target = path.join(staging, 'deploys');
  const overrides = siteDirectory && path.join(siteDirectory, 'deploys');
  const upstream = JSON.parse(await readFile(path.join(source, 'catalog.json'), 'utf8'));
  const localCatalog = await optionalJSON(overrides, 'catalog.json');
  const catalog = localCatalog === undefined ? upstream : localCatalog;
  if (localCatalog && !Object.hasOwn(localCatalog, 'languages') && upstream.languages) catalog.languages = upstream.languages;
  const catalogUrl = new URL('deploys/catalog.json', canonicalUrl).href;
  normalizeDeployCatalog(catalog, { baseURL: catalogUrl });
  await mkdir(target, { recursive: true });
  for (const schema of ['schema.json', 'catalog.schema.json', 'document.schema.json']) {
    await cp(path.join(source, schema), path.join(target, schema));
  }
  await mkdir(path.join(assets, 'packages'), { recursive: true });
  const downloaded = new Map();

  async function verifySeed(pack) {
    if (!/^[a-f0-9]{64}$/.test(pack.sha256) || pack.url !== `packages/${pack.sha256}.zip`
      || await hashFile(path.join(assets, pack.url)) !== pack.sha256) {
      throw new Error(`Reusable package failed verification: ${pack.sourceUrl}`);
    }
    return pack;
  }

  async function stageLanguage(asset, major) {
    const seed = seedPackages.find(pack => pack.language === asset.tag && pack.joomlaMajor === major
      && pack.sourceUrl === asset.url && pack.sourceSha256 === asset.sha256);
    if (seed) {
      await verifySeed(seed);
      downloaded.set(`language:${major}:${asset.tag}`, Promise.resolve(seed));
      return { tag: asset.tag, url: `../assets/${seed.url}`, sourceUrl: asset.url, sha256: seed.sha256 };
    }
    const derived = await prepareLanguagePackage({ root, cache, major, asset });
    if (!derived) return stagePackage(asset, `languages/${major}/${asset.tag}`);
    const filename = `${derived.sha256}.zip`;
    const provenanceUrl = `packages/${derived.sha256}.provenance.json`;
    await cp(derived.archive, path.join(assets, 'packages', filename));
    await writeFile(path.join(assets, provenanceUrl), `${JSON.stringify(derived.provenance, null, 2)}\n`);
    downloaded.set(`language:${major}:${asset.tag}`, Promise.resolve({ sourceUrl: asset.url,
      sourceSha256: asset.sha256, sha256: derived.sha256, url: `packages/${filename}`, provenanceUrl,
      delivery: 'on-demand', language: asset.tag, joomlaMajor: major }));
    return { tag: asset.tag, url: `../assets/packages/${filename}`, sourceUrl: asset.url, sha256: derived.sha256 };
  }

  async function stagePackage(asset, context) {
    if (!asset || typeof asset.url !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) {
      throw new Error(`Repository deploy package needs an immutable SHA-256: ${context}`);
    }
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error(`Repository deploy packages require HTTPS URLs: ${context}`);
    }
    const sha256 = asset.sha256.toLowerCase();
    if (!downloaded.has(sha256)) {
      downloaded.set(sha256, (async () => {
        const seed = seedPackages.find(pack => !pack.language && pack.sha256 === sha256 && pack.sourceSha256 === sha256);
        if (seed) return { ...await verifySeed(seed), sourceUrl: url.href };
        console.log(`Verifying deploy package ${context}…`);
        const archive = await downloadVerified(url.href, sha256, path.join(cache, 'packages', `${sha256}.zip`));
        const filename = `${sha256}.zip`;
        await cp(archive, path.join(assets, 'packages', filename));
        return { sourceUrl: url.href, sourceSha256: sha256, sha256, url: `packages/${filename}` };
      })());
    }
    const deployed = await downloaded.get(sha256);
    return { ...asset, url: `../assets/${deployed.url}`, sourceUrl: url.href, sha256: deployed.sha256 };
  }

  async function stageConfiguration(configuration, context) {
    if (!configuration) return;
    for (const key of ['extensions', 'languages']) {
      if (!configuration[key]) continue;
      configuration[key] = await Promise.all(configuration[key].map((asset, index) =>
        stagePackage(asset, `${context}/${key}/${index + 1}`)));
    }
    if (configuration.snapshot) {
      configuration.snapshot = await stagePackage(configuration.snapshot, `${context}/snapshot`);
    }
    if (configuration.template?.url) {
      const staged = await stagePackage({ url: configuration.template.url, sha256: configuration.template.sha256 }, `${context}/template`);
      configuration.template = { ...configuration.template, url: staged.url, sha256: staged.sha256 };
    }
  }

  for (const [version, packages] of Object.entries(catalog.languages || {})) {
    // These remain separate ZIP assets. English deployments never fetch them;
    // a deployment downloads only the languages it explicitly selects.
    catalog.languages[version] = await Promise.all(packages.map((asset) => stageLanguage(asset, version)));
  }

  // The shared runtime pins remain selectable even when a site omits or replaces the JCB preset.
  const jcb = await optionalJSON(source, 'jcb.json');
  catalog.jcbPackages = {};
  for (const [major, pin] of pinnedJcbPackages(jcb)) {
    catalog.jcbPackages[major] = await stagePackage(pin.package, `jcb/${major}`);
  }

  const ids = new Set();
  for (const descriptor of catalog.deploys) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(descriptor.id)
      || descriptor.file !== `./${descriptor.id}.json` || ids.has(descriptor.id)) {
      throw new Error('Deploy catalog entries must name distinct ./{id}.json files.');
    }
    ids.add(descriptor.id);
    const filename = `${descriptor.id}.json`;
    const local = await optionalJSON(overrides, filename);
    const deploy = local === undefined ? JSON.parse(await readFile(path.join(source, filename), 'utf8')) : local;
    const baseURL = new URL(descriptor.file, catalogUrl).href;
    normalizeDeploy(deploy, { baseURL, requireIntegrity: true });
    if (deploy.id !== descriptor.id) throw new Error(`Deploy identity mismatch: ${descriptor.id}`);
    await stageConfiguration(deploy.configuration, descriptor.id);
    for (const [version, configuration] of Object.entries(deploy.variants || {})) {
      await stageConfiguration(configuration, `${descriptor.id}/${version}`);
    }
    if (deploy.snapshot) deploy.snapshot = await stagePackage(deploy.snapshot, `${descriptor.id}/snapshot`);
    const normalized = normalizeDeploy(deploy, { baseURL, requireIntegrity: true });
    if (local !== undefined) {
      // A replacement may change Joomla compatibility, packages, and the opening view.
      descriptor.joomla = normalized.joomla;
      descriptor.requirements = normalized.requirements;
      if (localCatalog === undefined) {
        descriptor.title = normalized.title;
        descriptor.description = normalized.description;
      }
      descriptor.jcbVersions = {};
      for (const [major, pin] of pinnedJcbPackages(normalized)) descriptor.jcbVersions[major] = pin.version;
    }
    await writeFile(path.join(target, `${descriptor.id}.json`), `${JSON.stringify(deploy, null, 2)}\n`);
  }
  normalizeDeployCatalog(catalog, { baseURL: catalogUrl });
  await writeFile(path.join(target, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return { url: '../deploys/catalog.json', default: catalog.default, defaultsByJoomla: catalog.defaultsByJoomla,
    packages: await Promise.all(downloaded.values()) };
}
