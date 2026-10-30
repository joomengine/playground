/** Rebuild the themed registry from the exact supplied, verified SVG originals. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('../src/brand/icons/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('icon-manifest.json', directory), 'utf8'));
const icons = {};
for (const entry of manifest.icons.filter(item => item.files.currentColor)) {
  const svg = await readFile(new URL(`originals/${entry.source_path}`, directory), 'utf8');
  if (createHash('sha256').update(svg).digest('hex') !== entry.source_sha256) throw new Error(`Icon master checksum mismatch: ${entry.id}`);
  icons[entry.id] = svg.replace(/<svg\b([^>]*)>/, '<svg$1 fill="currentColor">').replace(/>\s+</g, '><').trim();
}
await writeFile(new URL('../src/icon-data.mjs', import.meta.url),
  '// Generated from src/brand/icons originals and the supplied action manifest. Do not redraw geometry.\nexport const ACTION_ICONS = Object.freeze(' + JSON.stringify(icons, null, 2) + ');\n');
console.log(`Generated ${Object.keys(icons).length} action icons; geometry and transparent bounds preserved.`);
