import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

/**
 * Review aid, never an approval importer. Supply built Joomla/JCB snapshot ZIPs;
 * it inventories literal image references and the installed JCB metadata hashes.
 * Dynamic network observations must still be reviewed before adding registry IDs.
 */
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node scripts/inventory-public-assets.mjs <installed-site-snapshot.zip> [...]');
const inventory = [];
for (const filename of files) {
  const archive = new Uint8Array(await readFile(filename));
  const sources = unzipSync(archive, { filter: entry => /\.(?:php|html|js|css|xml|json|ini)$/.test(entry.name)
    && !entry.name.includes('/vendor/') && entry.originalSize <= 3 * 1024 * 1024 });
  const references = new Map();
  for (const [name, bytes] of Object.entries(sources)) {
    const source = new TextDecoder().decode(bytes);
    // Static source inspection only; this script never rewrites rendered HTML.
    for (const match of source.matchAll(/https:\/\/[^\s"'<>)(]+?\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s"'<>)(]*)?/gi)) {
      const sites = references.get(match[0]) ?? [];
      if (!sites.includes(name)) sites.push(name);
      references.set(match[0], sites);
    }
    if (/\/(?:ComponentbuilderHelper\.php|helpers\/componentbuilder\.php)$/.test(name)) {
      const metadata = [...source.matchAll(/'url'\s*=>\s*'([^']+)'\s*,\s*'hash'\s*=>\s*'([a-f0-9]{32})'/g)]
        .map(([, url, md5]) => ({ url, md5 }));
      inventory.push({ archive: filename, archiveSha256: createHash('sha256').update(archive).digest('hex'),
        helper: name, helperSha256: createHash('sha256').update(bytes).digest('hex'), metadata });
    }
  }
  inventory.push({ archive: filename, literalReferences: [...references].sort(([a], [b]) => a.localeCompare(b))
    .map(([url, sources]) => ({ url, sources })) });
}
process.stdout.write(`${JSON.stringify({ approval: 'None: review candidates before editing the registry.', inventory }, null, 2)}\n`);
