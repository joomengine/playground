import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Patched module graphs need a new URL when their emitted bytes change. */
export function phpRuntimeAssetPath(minor, archiveSha256, overlays) {
  if (!/^8\.\d+$/.test(minor) || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error('Invalid PHP runtime asset identity.');
  const files = Object.entries(overlays).flatMap(([packageName, overlay]) => {
    if (!Array.isArray(overlay?.files) || !overlay.files.length) throw new Error(`Missing PHP overlay outputs: ${packageName}`);
    return overlay.files.map(({ file, sha256 }) => {
      if (typeof file !== 'string' || !file || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Invalid PHP overlay output: ${packageName}`);
      return [`${packageName}/${file}`, sha256];
    });
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!files.length || new Set(files.map(([file]) => file)).size !== files.length) throw new Error('PHP overlay outputs must be unique.');
  const id = createHash('sha256').update(JSON.stringify({ archiveSha256, files })).digest('hex');
  return `php/${minor}/${id}`;
}

/** Identify the published catalog/runtime, including rebuilds without a source commit. */
export async function writeBuildIdentity(directory, manifest) {
  const catalog = await readFile(path.join(directory, 'assets/version-catalog.json'));
  const id = createHash('sha256').update(JSON.stringify(manifest)).update('\n').update(catalog).digest('hex');
  const indexPath = path.join(directory, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const marker = /(<meta name="joomengine-build" content=")(?:[a-f0-9]{64})?(">)/g;
  if ([...html.matchAll(marker)].length !== 1) throw new Error('The application document must contain one build marker.');
  await writeFile(indexPath, html.replace(marker, (_, prefix, suffix) => `${prefix}${id}${suffix}`));
  await writeFile(path.join(directory, 'build.json'), `${JSON.stringify({ schemaVersion: 1, id })}\n`);
  return id;
}
