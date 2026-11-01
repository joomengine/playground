import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
