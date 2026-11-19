import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const action = readFileSync(new URL('../.github/actions/install-playwright/action.yml', import.meta.url), 'utf8');
const script = action.split('      run: |\n')[1].replace(/^        /gm, '');

test('browser setup renders before consulting apt and verifies any dependency repair', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'playwright-install-'));
  const log = path.join(directory, 'calls');
  try {
    const bin = path.join(directory, 'node_modules/.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'playwright'), `#!/bin/bash
echo "$*" >> "$CALL_LOG"
case "$1" in
  install) exit "$INSTALL_EXIT" ;;
  install-deps) exit "$DEPS_EXIT" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    // A render can fail on the first launch, or on both sides of the repair.
    writeFileSync(path.join(bin, 'node'), `#!/bin/bash
cat >/dev/null
echo "render $PLAYGROUND_BROWSER" >> "$CALL_LOG"
if [[ "$RENDER" == fail || ( "$RENDER" == repair && ! -f repaired ) ]]; then
  touch repaired
  exit 23
fi
`, { mode: 0o755 });
    const run = (browser, overrides = {}) => {
      writeFileSync(log, '');
      rmSync(path.join(directory, 'repaired'), { force: true });
      const { status, stderr } = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PLAYGROUND_BROWSER: browser,
          CALL_LOG: log, INSTALL_EXIT: '0', DEPS_EXIT: '0', RENDER: 'ok', ...overrides },
      });
      return { status, stderr, calls: readFileSync(log, 'utf8').trimEnd() };
    };
    for (const browser of ['chromium', 'firefox', 'webkit']) {
      const ready = run(browser);
      assert.equal(ready.status, 0, ready.stderr);
      assert.equal(ready.calls, `install ${browser}\nrender ${browser}`);
      const repaired = run(browser, { RENDER: 'repair' });
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(repaired.calls, `install ${browser}\nrender ${browser}\ninstall-deps ${browser}\nrender ${browser}`);
    }
    for (const browser of ['', 'chrome', 'chromium firefox', 'chromium; exit 0', '$(exit 0)']) {
      assert.notEqual(run(browser).status, 0);
      assert.equal(readFileSync(log, 'utf8'), '');
    }
    assert.equal(run('chromium', { INSTALL_EXIT: '7' }).status, 7);
    assert.equal(readFileSync(log, 'utf8'), 'install chromium\n');
    assert.equal(run('firefox', { RENDER: 'repair', DEPS_EXIT: '100' }).status, 100);
    assert.equal(readFileSync(log, 'utf8'), 'install firefox\nrender firefox\ninstall-deps firefox\n');
    assert.equal(run('webkit', { RENDER: 'fail' }).status, 23);
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
