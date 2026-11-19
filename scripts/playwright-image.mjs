import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function playwrightImage(lock) {
  const version = lock.packages?.['node_modules/playwright']?.version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || lock.packages['node_modules/playwright-core']?.version !== version) {
    throw new Error('Playwright and playwright-core must lock the same exact release to select the browser image.');
  }
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const image = playwrightImage(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url))));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `image=${image}\n`);
  console.log(image);
}
