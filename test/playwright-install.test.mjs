import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const action = readFileSync(new URL('../.github/actions/install-playwright/action.yml', import.meta.url), 'utf8');
const scripts = [...action.matchAll(/^      run: \|\n((?:        [^\n]*\n)+)/gm)]
  .map(match => match[1].replace(/^        /gm, ''));

test('browser setup verifies readiness before repairing and rechecks after repair', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'playwright-install-'));
  const log = path.join(directory, 'calls');
  const output = path.join(directory, 'outputs');
  try {
    const bin = path.join(directory, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'playwright'), `#!/bin/bash
echo "$*" >> "$CALL_LOG"
exit "$INSTALL_EXIT"
`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'node'), `#!/bin/bash
echo "render $PLAYGROUND_BROWSER" >> "$CALL_LOG"
exit "$RENDER_EXIT"
`, { mode: 0o755 });
    writeFileSync(path.join(directory, 'repair-deps.sh'), `echo "repair $PLAYGROUND_BROWSER" >> "$CALL_LOG"
exit "$DEPS_EXIT"
`);
    const run = (browser, step = 0, overrides = {}) => {
      writeFileSync(log, '');
      writeFileSync(output, '');
      const { status, stderr } = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', scripts[step]], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLAYGROUND_BROWSER: browser,
          GITHUB_OUTPUT: output, GITHUB_ACTION_PATH: directory, CALL_LOG: log, INSTALL_EXIT: '0', DEPS_EXIT: '0', RENDER_EXIT: '0', ...overrides },
      });
      return { status, stderr, calls: readFileSync(log, 'utf8').trimEnd(), outputs: readFileSync(output, 'utf8') };
    };
    for (const browser of ['chromium', 'firefox', 'webkit']) {
      const ready = run(browser);
      assert.equal(ready.status, 0, ready.stderr);
      assert.equal(ready.calls, `install ${browser}\nrender ${browser}`);
      assert.equal(ready.outputs, '');
      assert.match(run(browser, 0, { RENDER_EXIT: '23' }).outputs, /^repair=true$/m);
      const repaired = run(browser, 1);
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(repaired.calls, `repair ${browser}\nrender ${browser}`);
    }
    for (const browser of ['', 'chrome', 'chromium firefox', 'chromium; exit 0', '$(exit 0)']) {
      assert.notEqual(run(browser).status, 0);
      assert.equal(readFileSync(log, 'utf8'), '');
    }
    assert.equal(run('chromium', 0, { INSTALL_EXIT: '7' }).status, 7);
    assert.equal(readFileSync(log, 'utf8'), 'install chromium\n');
    assert.equal(run('firefox', 1, { DEPS_EXIT: '100' }).status, 100);
    assert.equal(readFileSync(log, 'utf8'), 'repair firefox\n');
    assert.equal(run('webkit', 1, { RENDER_EXIT: '23' }).status, 23);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('every validation browser install uses the shared Ubuntu action', () => {
  const source = readFileSync(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
  assert.equal(source.match(/uses: \.\/\.github\/actions\/install-playwright/g)?.length, 6);
  assert.doesNotMatch(source, /playwright install --with-deps|apt-mirrors/);
  for (const block of source.split(/(?=^  [\w-]+:\n)/m).filter(block => block.includes('uses: ./.github/actions/install-playwright'))) {
    assert.match(block, /^    runs-on: ubuntu-24\.04$/m);
    assert.match(block, /uses: \.\/\.github\/actions\/install-playwright\n        with:\n          browser: (?:\$\{\{ matrix\.browser \}\}|chromium)\n/);
  }
});
