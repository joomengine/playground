import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { downloadVerified } from './assets.mjs';
import { normalizeDeploy, normalizeDeployCatalog } from '../src/deploys.mjs';
import { deriveJcbPackage, isReviewedJcbPackage } from './jcb-package.mjs';
import { prepareLanguagePackage } from './language-packages.mjs';

/** Stage verified repository recipes and their packages on the playground origin. */
export async function stageDeployCatalog({ root, staging, assets, cache, canonicalUrl }) {
  const source = path.join(root, 'deploys');
  const target = path.join(staging, 'deploys');
  const catalog = JSON.parse(await readFile(path.join(source, 'catalog.json'), 'utf8'));
  const catalogUrl = new URL('deploys/catalog.json', canonicalUrl).href;
  normalizeDeployCatalog(catalog, { baseURL: catalogUrl });
  await mkdir(target, { recursive: true });
  for (const schema of ['schema.json', 'catalog.schema.json']) {
    await cp(path.join(source, schema), path.join(target, schema));
  }
  await mkdir(path.join(assets, 'packages'), { recursive: true });
  const downloaded = new Map();

  async function stageLanguage(asset, major) {
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
        console.log(`Verifying deploy package ${context}…`);
        let archive = await downloadVerified(url.href, sha256, path.join(cache, 'packages', `${sha256}.zip`));
        let deployedSha256 = sha256;
        let provenanceUrl;
        if (isReviewedJcbPackage(sha256)) {
          const derived = await deriveJcbPackage({ root, cache, archive, sourceUrl: url.href, sourceSha256: sha256 });
          archive = derived.archive;
          deployedSha256 = derived.sha256;
          provenanceUrl = `packages/${deployedSha256}.provenance.json`;
          await writeFile(path.join(assets, provenanceUrl), `${JSON.stringify(derived.provenance, null, 2)}\n`);
        }
        const filename = `${deployedSha256}.zip`;
        await cp(archive, path.join(assets, 'packages', filename));
        return { sourceUrl: url.href, sourceSha256: sha256, sha256: deployedSha256, url: `packages/${filename}`,
          ...(provenanceUrl ? { provenanceUrl } : {}) };
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

  const ids = new Set();
  for (const descriptor of catalog.deploys) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(descriptor.id)
      || descriptor.file !== `./${descriptor.id}.json` || ids.has(descriptor.id)) {
      throw new Error('Deploy catalog entries must name distinct ./{id}.json files.');
    }
    ids.add(descriptor.id);
    const deploy = JSON.parse(await readFile(path.join(source, `${descriptor.id}.json`), 'utf8'));
    const baseURL = new URL(descriptor.file, catalogUrl).href;
    normalizeDeploy(deploy, { baseURL, requireIntegrity: true });
    if (deploy.id !== descriptor.id) throw new Error(`Deploy identity mismatch: ${descriptor.id}`);
    await stageConfiguration(deploy.configuration, descriptor.id);
    for (const [version, configuration] of Object.entries(deploy.variants || {})) {
      await stageConfiguration(configuration, `${descriptor.id}/${version}`);
    }
    if (deploy.snapshot) deploy.snapshot = await stagePackage(deploy.snapshot, `${descriptor.id}/snapshot`);
    normalizeDeploy(deploy, { baseURL, requireIntegrity: true });
    await writeFile(path.join(target, `${descriptor.id}.json`), `${JSON.stringify(deploy, null, 2)}\n`);
  }
  normalizeDeployCatalog(catalog, { baseURL: catalogUrl });
  await writeFile(path.join(target, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return { url: '../deploys/catalog.json', default: catalog.default, defaultsByJoomla: catalog.defaultsByJoomla,
    packages: await Promise.all(downloaded.values()) };
}
