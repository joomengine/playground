import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { downloadVerified } from './assets.mjs';
import { normalizeBlueprint, normalizeBlueprintCatalog } from '../src/blueprints.mjs';

/** Stage verified repository recipes and their packages on the playground origin. */
export async function stageBlueprintCatalog({ root, staging, assets, cache, canonicalUrl }) {
  const source = path.join(root, 'blueprints');
  const target = path.join(staging, 'blueprints');
  const catalog = JSON.parse(await readFile(path.join(source, 'catalog.json'), 'utf8'));
  const catalogUrl = new URL('blueprints/catalog.json', canonicalUrl).href;
  normalizeBlueprintCatalog(catalog, { baseURL: catalogUrl });
  await mkdir(target, { recursive: true });
  for (const schema of ['schema.json', 'catalog.schema.json']) {
    await cp(path.join(source, schema), path.join(target, schema));
  }
  await mkdir(path.join(assets, 'packages'), { recursive: true });
  const downloaded = new Map();

  async function stagePackage(asset, context) {
    if (!asset || typeof asset.url !== 'string' || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) {
      throw new Error(`Repository blueprint package needs an immutable SHA-256: ${context}`);
    }
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error(`Repository blueprint packages require HTTPS URLs: ${context}`);
    }
    const sha256 = asset.sha256.toLowerCase();
    const filename = `${sha256}.zip`;
    if (!downloaded.has(sha256)) {
      downloaded.set(sha256, (async () => {
        console.log(`Verifying blueprint package ${context}…`);
        const archive = await downloadVerified(url.href, sha256, path.join(cache, 'packages', filename));
        await cp(archive, path.join(assets, 'packages', filename));
        return { sourceUrl: url.href, sha256, url: `packages/${filename}` };
      })());
    }
    await downloaded.get(sha256);
    return { ...asset, url: `../assets/packages/${filename}`, sourceUrl: url.href, sha256 };
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
  }

  for (const [version, packages] of Object.entries(catalog.languages || {})) {
    catalog.languages[version] = await Promise.all(packages.map((asset) =>
      stagePackage(asset, `languages/${version}/${asset.tag}`)));
  }

  const ids = new Set();
  for (const descriptor of catalog.blueprints) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(descriptor.id)
      || descriptor.file !== `./${descriptor.id}.json` || ids.has(descriptor.id)) {
      throw new Error('Blueprint catalog entries must name distinct ./{id}.json files.');
    }
    ids.add(descriptor.id);
    const blueprint = JSON.parse(await readFile(path.join(source, `${descriptor.id}.json`), 'utf8'));
    const baseURL = new URL(descriptor.file, catalogUrl).href;
    normalizeBlueprint(blueprint, { baseURL, requireIntegrity: true });
    if (blueprint.id !== descriptor.id) throw new Error(`Blueprint identity mismatch: ${descriptor.id}`);
    await stageConfiguration(blueprint.configuration, descriptor.id);
    for (const [version, configuration] of Object.entries(blueprint.variants || {})) {
      await stageConfiguration(configuration, `${descriptor.id}/${version}`);
    }
    if (blueprint.snapshot) blueprint.snapshot = await stagePackage(blueprint.snapshot, `${descriptor.id}/snapshot`);
    normalizeBlueprint(blueprint, { baseURL, requireIntegrity: true });
    await writeFile(path.join(target, `${descriptor.id}.json`), `${JSON.stringify(blueprint, null, 2)}\n`);
  }
  normalizeBlueprintCatalog(catalog, { baseURL: catalogUrl });
  await writeFile(path.join(target, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  return { url: '../blueprints/catalog.json', default: catalog.default, packages: await Promise.all(downloaded.values()) };
}
