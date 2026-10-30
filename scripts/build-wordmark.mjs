/** Build a clean, glare-free header wordmark from the existing brand glyphs. */
import { readFile, writeFile } from 'node:fs/promises';

const brand = new URL('../src/brand/', import.meta.url);
const source = await readFile(new URL('joomengine-code-light.svg', brand), 'utf8');
// This established vector artwork contains JOOMENGINE followed by CODE.
// Reuse only its ten name glyphs; no bitmap, glow, gradient or filter is needed.
const lettering = source.match(/<g fill="none" stroke="url\(#[^"]+-ink\)"[^>]*>([\s\S]*?)<\/g>/)?.[1];
const paths = lettering?.match(/<path\b[^>]*\/>/g);
if (paths?.length !== 14) throw new Error('Expected the existing fourteen JOOMENGINE CODE glyphs.');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80" viewBox="0 0 400 80" role="img" aria-labelledby="wordmark-title wordmark-description">
  <title id="wordmark-title">JoomEngine</title>
  <desc id="wordmark-description">JOOMENGINE in solid black geometric lettering on a transparent background, without glare effects.</desc>
  <g transform="translate(6.8 24.36) scale(.92)" fill="none" stroke="#000" stroke-width="5.6" stroke-linejoin="round" stroke-linecap="square">
${paths.slice(0, 10).map(path => `    ${path}`).join('\n')}
  </g>
</svg>
`;
await writeFile(new URL('joomengine-logo-light.svg', brand), svg);
console.log('Clean black JoomEngine wordmark generated from the existing vector lettering.');
