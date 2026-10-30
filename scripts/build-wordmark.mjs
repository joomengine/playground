/** Retain the original wordmark pixels, transparency and gold highlights on light backgrounds. */
import { readFile, writeFile } from 'node:fs/promises';

const brand = new URL('../src/brand/', import.meta.url);
const original = await readFile(new URL('joomengine-logo.webp', brand));

// The original artwork has no accompanying vector outlines. An SVG composite
// keeps that exact artwork: neutral lettering becomes ink, while chromatic
// highlights retain their source colors. In particular, this is not inversion,
// which would turn the gold flares blue. The final alpha is the original alpha.
const differences = [[1, -1, 0], [-1, 1, 0], [1, 0, -1], [-1, 0, 1], [0, 1, -1], [0, -1, 1]];
const channels = differences.map((rgb, i) => {
  const row = `${rgb.join(' ')} 0 0`;
  return `      <feColorMatrix in="SourceGraphic" type="matrix" values="${row} ${row} ${row} 0 0 0 0 1" result="difference-${i}"/>`;
}).join('\n');
const maxima = differences.slice(1).map((_, i) =>
  `      <feBlend in="${i ? `chroma-${i}` : 'difference-0'}" in2="difference-${i + 1}" mode="lighten" result="chroma-${i + 1}"/>`).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="80" viewBox="0 0 400 80">
  <title>JoomEngine</title>
  <desc>Original JoomEngine wordmark with dark lettering and unchanged colored highlights on a transparent background.</desc>
  <defs>
    <filter id="light-wordmark" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
${channels}
${maxima}
      <feComponentTransfer in="chroma-5" result="highlight-strength">
        <feFuncR type="linear" slope="4"/>
        <feFuncG type="linear" slope="4"/>
        <feFuncB type="linear" slope="4"/>
      </feComponentTransfer>
      <feColorMatrix in="highlight-strength" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0" result="highlight-mask"/>
      <feComposite in="SourceGraphic" in2="highlight-mask" operator="in" result="highlights"/>
      <feFlood flood-color="#1c2439" result="ink"/>
      <feComposite in="ink" in2="SourceAlpha" operator="in" result="lettering"/>
      <feComposite in="lettering" in2="highlight-mask" operator="out" result="neutral-lettering"/>
      <feComposite in="highlights" in2="neutral-lettering" operator="arithmetic" k2="1" k3="1"/>
    </filter>
  </defs>
  <image width="400" height="80" filter="url(#light-wordmark)" xlink:href="data:image/webp;base64,${original.toString('base64')}"/>
</svg>
`;
await writeFile(new URL('joomengine-logo-light.svg', brand), svg);
console.log('Light wordmark generated from the original transparent artwork.');
