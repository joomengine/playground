import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { playwrightImage } from '../scripts/playwright-image.mjs';

test('browser image selection tracks the exact locked release and requires matching engines', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  const version = lock.packages['node_modules/playwright'].version;
  assert.equal(playwrightImage(lock), `mcr.microsoft.com/playwright:v${version}-noble`);
  const selected = (version, core = version) => playwrightImage({ packages: {
    'node_modules/playwright': { version }, 'node_modules/playwright-core': { version: core },
  } });
  assert.equal(selected('2.0.1'), 'mcr.microsoft.com/playwright:v2.0.1-noble');
  for (const value of [undefined, '', 'latest', '^1.65.0', '1.65.0-beta', '1.65.0\nimage=example.org/test']) {
    assert.throws(() => selected(value), /same exact release/);
  }
  assert.throws(() => selected('2.0.1', '2.0.0'), /same exact release/);
});

test('all validation and hosted browser jobs use the locked image and verify the installed engine', () => {
  const checks = [
    ['validate.yml', 'needs.checks.outputs.browser_image', ['interaction', 'browser', 'php-network', 'jcb-network', 'compatibility', 'version-catalog']],
    ['network-verify.yml', 'needs.browser-image.outputs.image', ['verify']],
  ];
  for (const [filename, image, jobs] of checks) {
    const workflow = readFileSync(new URL(`../.github/workflows/${filename}`, import.meta.url), 'utf8');
    assert.match(workflow, /id: browser_image\n\s+run: node scripts\/playwright-image\.mjs/);
    assert.doesNotMatch(workflow, /playwright install|\.github\/actions\/install-playwright/);
    const blocks = workflow.split(/(?=^  [\w-]+:\n)/m);
    for (const job of jobs) {
      const block = blocks.find(value => value.startsWith(`  ${job}:\n`));
      assert.ok(block.includes(`image: \${{ ${image} }}`), job);
      assert.match(block, /^      options: --user 1001 --init --ipc=host$/m);
      assert.match(block, /^        shell: bash$/m);
      assert.match(block, /PLAYGROUND_BROWSER: (?:\$\{\{ matrix\.browser \}\}|chromium)\n        run: node scripts\/verify-ci-browser\.mjs/);
    }
  }
});
