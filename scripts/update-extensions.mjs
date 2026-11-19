import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseMetadata } from './release-metadata.mjs';
import { parsePackageUpdates } from '../src/dynamic-catalog.mjs';
import { downloadCatalogZip } from './version-catalog.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const raw = 'https://raw.githubusercontent.com/joomengine/';
const stable = /^\d+\.\d+\.\d+$/;
const compare = (left, right) => left.localeCompare(right, 'en', { numeric: true });
const releasePackages = {
  patchtester: version => `com_patchtester_${version}.zip`,
  weblinks: version => `pkg-weblinks-${version}.zip`,
};

export function githubExtensionRelease(id, release) {
  const version = release.tag_name?.replace(/^v/, '');
  if (release.draft !== false || release.prerelease !== false || !stable.test(version)) throw new Error(`Invalid stable ${id} release`);
  const name = releasePackages[id](version);
  const url = `https://github.com/joomla-extensions/${id}/releases/download/${release.tag_name}/${name}`;
  const assets = release.assets.filter(asset => asset.name === name && asset.browser_download_url === url);
  if (assets.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(assets[0].digest)) throw new Error(`Missing checksummed ${id} release ZIP for ${version}`);
  return { version, url, sha256: assets[0].digest.slice(7) };
}

export async function updateExtensions({ root = project, fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const read = url => readReleaseMetadata(url, fetchImpl, token);
  const directory = path.join(root, 'deploys');
  const ids = ['jcb', 'jcb-mcp', 'servicedirectory', 'patchtester', 'weblinks'];
  const recipes = new Map(await Promise.all(ids.map(async id => [id, JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8'))])));
  const cache = path.join(root, '.cache/packages');
  const changed = new Set();
  const retiredJcb = [];

  function slot(id, major, repository) {
    const recipe = recipes.get(id);
    const config = major ? recipe.variants[major] : recipe.configuration;
    const matches = config.extensions.filter(({ url }) => {
      const source = new URL(url);
      return ['https://github.com', 'https://codeload.github.com'].includes(source.origin) && source.pathname.startsWith(`/${repository}/`);
    });
    if (matches.length !== 1) throw new Error(`Expected one ${repository} extension in ${id} ${major || ''}`);
    return { id, pin: matches[0] };
  }

  async function apply(entry, slots) {
    const { pin } = slots[0];
    if (slots.some(slot => slot.pin.url !== pin.url || slot.pin.sha256 !== pin.sha256 || slot.pin.sha512 !== pin.sha512)) {
      throw new Error('The JCB and JCB + MCP recipes specify different pins for their shared JCB package');
    }
    const sameURL = pin.url === entry.url;
    if (sameURL && ((entry.sha256 && pin.sha256 !== entry.sha256) || (pin.sha512 && entry.sha512 && pin.sha512 !== entry.sha512))) {
      throw new Error(`Published checksum changed for ${entry.url}`);
    }
    let sha256 = entry.sha256;
    if (!sha256 && sameURL && pin.sha512 === entry.sha512) sha256 = pin.sha256;
    if (!sha256) {
      const zip = await downloadCatalogZip({ ...entry, ...(sameURL ? { sha256: pin.sha256 } : {}) }, fetchImpl);
      sha256 = zip.sha256;
      await mkdir(cache, { recursive: true });
      await writeFile(path.join(cache, `${sha256}.zip`), zip.bytes);
    }
    for (const { id, pin: target } of slots) {
      if (target.url === entry.url && target.sha256 === sha256 && target.sha512 === entry.sha512) continue;
      Object.assign(target, { url: entry.url, sha256 });
      if (entry.sha512) target.sha512 = entry.sha512;
      changed.add(id);
    }
  }

  async function feed({ url, repository, element, major, slots }) {
    const entries = parsePackageUpdates(await read(url), repository, element)
      .filter(entry => stable.test(entry.version) && (!major || entry.version.startsWith(`${major}.`)))
      .sort((a, b) => compare(b.version, a.version));
    const entry = entries[0];
    if (!entry) throw new Error(`No stable checksummed package in ${url}`);
    if (entries.some(item => item.version === entry.version && item.sha512 !== entry.sha512)) {
      throw new Error(`Conflicting published checksums for ${entry.url}`);
    }
    const { pin } = slots[0];
    let current = pin.url.match(/\/v(\d+\.\d+\.\d+)(?:\.zip)?$/)?.[1];
    if (!current && repository === 'joomengine/pkg-servicedirectory') {
      // These reviewed snapshots can include post-tag fixes. Keep those fixes until the next stable release.
      const commit = pin.url.match(/\/zip\/([a-f0-9]{40})$/)?.[1];
      if (!commit) throw new Error(`Unrecognized Service Directory pin ${pin.url}`);
      const manifest = await read(`${raw}pkg-servicedirectory/${commit}/pkg_servicedirectory.xml`);
      current = manifest.match(/<version>(\d+\.\d+\.\d+)<\/version>/)?.[1];
      if (current === entry.version) return;
    }
    if (!current || compare(entry.version, current) < 0) throw new Error(`Cannot advance ${pin.url} to ${entry.version}`);
    if (repository === 'joomengine/pkg-component-builder' && current !== entry.version) {
      retiredJcb.push({ version: current, package: { ...pin } });
    }
    await apply(entry, slots);
  }

  const updates = [];
  for (const major of ['5', '6']) {
    const repository = 'joomengine/pkg-component-builder';
    const slots = [slot('jcb', major, repository)];
    if (major === '6') slots.push(slot('jcb-mcp', major, repository));
    updates.push(feed({ url: `${raw}Joomla-Component-Builder/refs/heads/${major}.x/componentbuilder_update_server.xml`,
      element: 'pkg_component_builder', repository, major, slots }));
    const service = 'joomengine/pkg-servicedirectory';
    updates.push(feed({ url: `${raw}Joomla-Service-Directory/refs/heads/${major}.x/update_server.xml`,
      element: 'pkg_servicedirectory', repository: service, major, slots: [slot('servicedirectory', major, service)] }));
  }
  const mcp = 'joomengine/mcp_package';
  updates.push(feed({ url: `${raw}mcp_package/main/.github/joomengine_mcp_update_server.xml`,
    element: 'pkg_joomengine_mcp', repository: mcp, slots: [slot('jcb-mcp', '6', mcp)] }));
  for (const id of Object.keys(releasePackages)) {
    const repository = `joomla-extensions/${id}`;
    updates.push((async () => {
      const entry = githubExtensionRelease(id, JSON.parse(await read(`https://api.github.com/repos/${repository}/releases/latest`)));
      const target = slot(id, null, repository);
      const current = new URL(target.pin.url).pathname.split('/')[5]?.replace(/^v/, '');
      if (!stable.test(current) || compare(entry.version, current) < 0) throw new Error(`Cannot advance ${id} from ${current} to ${entry.version}`);
      await apply(entry, [target]);
    })());
  }
  await Promise.all(updates);
  if (retiredJcb.length) {
    const filename = path.join(root, 'versions.json');
    const versions = JSON.parse(await readFile(filename, 'utf8'));
    versions.retiredJcb ??= [];
    for (const entry of retiredJcb.sort((a, b) => compare(a.version, b.version))) {
      const existing = versions.retiredJcb.find(item => item.version === entry.version);
      if (existing && (existing.package.url !== entry.package.url || existing.package.sha256 !== entry.package.sha256)) {
        throw new Error(`Conflicting historical JCB package for ${entry.version}`);
      }
      if (!existing) versions.retiredJcb.push(entry);
    }
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(versions, null, 2) + '\n');
    await rename(temporary, filename);
  }
  for (const id of changed) {
    const filename = path.join(directory, `${id}.json`);
    const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(recipes.get(id), null, 2) + '\n');
    await rename(temporary, filename);
  }
  return [...changed].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = await updateExtensions();
  console.log(changed.length ? `Updated extension recipes: ${changed.join(', ')}` : 'All extension recipes are current.');
}
