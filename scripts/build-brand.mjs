/** Reproducible, conservative framing/minification: no paths/colors are changed. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('../src/brand/', import.meta.url);
const source = await readFile(new URL('JoomEngine_Pearl_Logo.original.svg', directory), 'utf8');
const manifest = JSON.parse(await readFile(new URL('brand-manifest.json', directory), 'utf8'));
if (createHash('sha256').update(source).digest('hex') !== manifest.sha256) throw new Error('Brand master checksum mismatch.');
for (const [name, size] of [['rocket.svg', 24], ['favicon.svg', 32]]) {
  const svg = source.replace(/<\?xml[^>]*\?>\s*/, '').replace(/<svg\b([^>]*)>/, (_root, attrs) =>
    `<svg${attrs.replace(/\s(width|height|viewBox|preserveAspectRatio)="[^"]*"/g, '')} width="${size}" height="${size}" viewBox="${manifest.normalized_viewBox}" preserveAspectRatio="xMidYMid meet">`)
    .replace(/>\s+</g, '><').trim();
  await writeFile(new URL(name, directory), `${svg}\n`);
}
console.log('Pearl rocket and favicon regenerated without changing vector geometry.');
