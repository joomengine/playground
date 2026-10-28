import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { downloadVerified, safeArchivePath } from './assets.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const epoch = new Date(1980, 0, 1);
const preparedSources = new Map();
const archiveFiles = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, [value, { mtime: epoch }]])), { level: 9 });

/** Package the official translation tree, filling only its release placeholders. */
export function assembleLanguagePackage(sourceFiles, { major, tag, version, date, sourceCommit }) {
  if (!['5', '6'].includes(major) || !/^[a-z]{2}-[A-Z]{2}$/.test(tag)
    || !/^\d+\.\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new TypeError('Invalid pinned language package identity.');
  const prefix = `core-translations-${sourceCommit}/joomla_v${major}/translations/package/${tag}/`;
  const files = {};
  const originals = [];
  const changes = [];
  for (const [name, original] of Object.entries(sourceFiles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!name.startsWith(prefix) || name.endsWith('/')) continue;
    const relative = safeArchivePath(name.slice(prefix.length));
    let bytes = original;
    originals.push({ path: relative, size: original.byteLength, sha256: digest(original) });
    if (relative.endsWith('.xml')) {
      const source = decoder.decode(original);
      const completed = source.replace(/<version\s*\/>/g, `<version>${version}</version>`)
        .replace(/<creationDate\s*\/>/g, `<creationDate>${date}</creationDate>`);
      if (completed !== source) {
        bytes = encoder.encode(completed);
        changes.push({ path: relative, beforeSha256: digest(original), afterSha256: digest(bytes) });
      }
    }
    files[relative] = bytes;
  }
  for (const required of [`pkg_${tag}.xml`, `language/${tag}/langmetadata.xml`,
    `administrator/language/${tag}/langmetadata.xml`, `api/language/${tag}/langmetadata.xml`]) {
    if (!files[required]) throw new Error(`Official language package is incomplete: ${major}/${tag}/${required}`);
  }
  const manifest = decoder.decode(files[`pkg_${tag}.xml`]);
  if (!manifest.includes(`<packagename>${tag}</packagename>`) || !manifest.includes(`<version>${version}</version>`)) {
    throw new Error(`Official language identity differs from its pin: ${major}/${tag}`);
  }
  for (const client of ['language', 'administrator/language', 'api/language']) {
    const metadata = decoder.decode(files[`${client}/${tag}/langmetadata.xml`]);
    if (!metadata.includes(`<tag>${tag}</tag>`)) throw new Error(`Language metadata tag differs: ${major}/${tag}/${client}`);
  }
  const nestedArchives = [];
  for (const match of manifest.matchAll(/<file\b([^>]*)>([^<]+)<\/file>/g)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map((entry) => [entry[1], entry[2]]));
    const filename = safeArchivePath(match[2].trim());
    const clientDirectory = { site: 'language', administrator: 'administrator/language', api: 'api/language' }[attributes.client];
    if (attributes.type !== 'language' || attributes.id !== tag || !clientDirectory || !/^[a-zA-Z0-9_-]+\.zip$/.test(filename)) {
      throw new Error(`Unsupported official language archive declaration: ${major}/${tag}/${filename}`);
    }
    const directory = `${clientDirectory}/${tag}/`;
    const members = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(directory))
      .map(([name, bytes]) => [name.slice(directory.length), bytes]));
    if (!members['install.xml']) throw new Error(`Language subpackage manifest is missing: ${major}/${tag}/${filename}`);
    if (files[filename]) throw new Error(`Official language source unexpectedly supplies an archive: ${major}/${tag}/${filename}`);
    files[filename] = archiveFiles(members);
    nestedArchives.push({ path: filename, sourceDirectory: directory, sha256: digest(files[filename]), fileCount: Object.keys(members).length });
  }
  const inventory = Object.entries(files).map(([name, bytes]) => ({ path: name, size: bytes.byteLength, sha256: digest(bytes) }));
  const bytes = archiveFiles(files);
  return { bytes, sha256: digest(bytes), provenance: { schemaVersion: 1, major, tag, version, date,
    sourceCommit, sourceFilesSha256: digest(JSON.stringify(originals)), fileCount: inventory.length,
    placeholderChanges: changes, nestedArchives, files: inventory } };
}

export async function prepareLanguagePackage({ root, cache, major, asset }) {
  // Ordinary published language ZIPs do not need the source-assembly pin set.
  if (!/^https:\/\/codeload\.github\.com\/joomla\/core-translations\/zip\/[a-f0-9]{40}$/.test(asset.url)) return null;
  const pins = JSON.parse(await readFile(path.join(root, 'dependencies/joomla-languages/packages.json'), 'utf8'));
  if (asset.url !== pins.source.url || asset.sha256 !== pins.source.sha256) {
    throw new Error(`Official language source differs from its reviewed pin: ${major}/${asset.tag}`);
  }
  const pin = pins.packages.find((item) => item.major === major && item.tag === asset.tag);
  if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error(`Language package pin is missing: ${major}/${asset.tag}`);
  const sourceKey = `${cache}:${pins.source.sha256}`;
  if (!preparedSources.has(sourceKey)) {
    preparedSources.set(sourceKey, (async () => {
      const archive = await downloadVerified(pins.source.url, pins.source.sha256,
        path.join(cache, 'language-sources', `${pins.source.sha256}.zip`));
      const prefixes = pins.packages.map((item) => `core-translations-${pins.source.commit}/joomla_v${item.major}/translations/package/${item.tag}/`);
      return unzipSync(new Uint8Array(await readFile(archive)), { filter: (entry) => prefixes.some((prefix) => entry.name.startsWith(prefix)) });
    })());
  }
  const sourceFiles = await preparedSources.get(sourceKey);
  const built = assembleLanguagePackage(sourceFiles, { ...pin, date: pins.source.date, sourceCommit: pins.source.commit });
  if (built.sha256 !== pin.sha256) throw new Error(`Derived language checksum differs: ${major}/${asset.tag}`);
  const directory = path.join(cache, 'language-packages');
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, `${built.sha256}.zip`);
  await writeFile(archive, built.bytes);
  return { archive, sha256: built.sha256, provenance: { ...built.provenance, source: pins.source,
    distribution: 'JoomEngine assembly of official Joomla translation sources', outputSha256: built.sha256,
    builderSha256: digest(await readFile(new URL(import.meta.url))) } };
}
