import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJoomlaReleases } from '../src/dynamic-catalog.mjs';
import { downloadCatalogZip, joomlaPackagePhpMinimum } from './version-catalog.mjs';
import { readReleaseMetadata } from './release-metadata.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const releaseURL = 'https://api.github.com/repos/joomla/joomla-cms/releases?per_page=100';
const compare = (left, right) => left.localeCompare(right, 'en', { numeric: true });

export async function updateJoomla({ root = project, fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const file = path.join(root, 'versions.json');
  const pins = JSON.parse(await readFile(file, 'utf8'));
  const releases = JSON.parse(await readReleaseMetadata(releaseURL, fetchImpl, token));
  const stable = releases.filter(item => item.draft === false && item.prerelease === false && /^v?\d+\.\d+\.\d+$/.test(item.tag_name))
    .sort((a, b) => compare(b.tag_name.replace(/^v/, ''), a.tag_name.replace(/^v/, '')));
  const advanced = [];
  for (const [index, current] of pins.joomla.entries()) {
    const major = current.version.split('.')[0];
    if (!['5', '6'].includes(major)) continue;
    const latest = stable.find(release => release.tag_name.replace(/^v/, '').startsWith(`${major}.`));
    if (!latest) throw new Error(`Joomla has no published stable release for major ${major} in the current feed`);
    const version = latest.tag_name.replace(/^v/, '');
    const name = `Joomla_${version}-Stable-Full_Package.zip`;
    const assets = latest.assets.filter(asset => asset.name === name && asset.state === 'uploaded');
    const [entry] = parseJoomlaReleases([{ ...latest, assets }]);
    if (assets.length !== 1 || !entry?.sha256) throw new Error(`Joomla ${version} requires one checksummed stable full installer`);
    if (compare(version, current.version) < 0) throw new Error(`Upstream Joomla ${version} is older than the accepted ${current.version}`);
    if (version === current.version) {
      if (entry.url !== current.url || entry.sha256 !== current.sha256) throw new Error(`Published Joomla ${version} installer identity changed`);
      continue;
    }

    const { bytes } = await downloadCatalogZip(entry, fetchImpl);
    const minimum = joomlaPackagePhpMinimum(bytes);
    // The native validation matrix boots these exact PHP lines. Bootstrap and
    // catalog validation also check the actual patch runtime shipped by the build.
    const minimumLine = minimum.split('.').slice(0, 2).join('.');
    const php = current.php.filter(line => compare(line, minimumLine) >= 0);
    if (!php.length) throw new Error(`Joomla ${version} requires PHP ${minimum}; no supported lines remain`);
    if (current.version === pins.defaults.joomlaVersion) {
      if (!php.includes(pins.defaults.phpVersion)) throw new Error(`Joomla ${version} requires a new default PHP line`);
      pins.defaults.joomlaVersion = version;
    }
    pins.retiredJoomla ??= [];
    pins.retiredJoomla.push(current);
    pins.joomla[index] = { version, label: entry.label, php, url: entry.url, sha256: entry.sha256 };
    advanced.push(version);
    await mkdir(path.join(root, '.cache'), { recursive: true });
    await writeFile(path.join(root, '.cache', `Joomla_${version}.zip`), bytes);
  }
  if (advanced.length) {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(pins, null, 2) + '\n');
    await rename(temp, file);
  }
  return advanced;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const advanced = await updateJoomla();
  console.log(advanced.length ? `Updated stable Joomla baselines: ${advanced.join(', ')}` : 'Stable Joomla baselines are current.');
}
