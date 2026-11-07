import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const action = readFileSync(new URL('../.github/actions/install-playwright/action.yml', import.meta.url), 'utf8');
const script = action.split('      run: |\n')[1].replace(/^        /gm, '');

test('browser installation validates input and fails closed at each setup boundary', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'playwright-install-'));
  const log = path.join(directory, 'calls'), mirrors = path.join(directory, 'mirrors');
  try {
    // Exercise the action's real Bash script without touching host apt settings
    // or downloading browsers. Only its three external setup commands are fake.
    for (const command of ['grep', 'sudo', 'npx']) {
      writeFileSync(path.join(directory, command), `#!/bin/bash\nprintf '%s\\n' '${command}' "$@" >> "$CALL_LOG"\n${command === 'sudo' ? 'cat > "$MIRROR_RESULT"\n' : ''}exit "\${${command.toUpperCase()}_EXIT:-0}"\n`, { mode: 0o755 });
    }
    const run = (browser, overrides = {}) => {
      writeFileSync(log, ''); writeFileSync(mirrors, '');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
        encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, PLAYGROUND_BROWSER: browser,
          CALL_LOG: log, MIRROR_RESULT: mirrors, GREP_EXIT: '0', SUDO_EXIT: '0', NPX_EXIT: '0', ...overrides },
      });
      return { ...result, calls: readFileSync(log, 'utf8'), mirrors: readFileSync(mirrors, 'utf8') };
    };
    const expectedMirrors = 'https://archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://security.ubuntu.com/ubuntu/\tpriority:2\n';
    for (const browser of ['chromium', 'firefox', 'webkit']) {
      const result = run(browser);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.mirrors, expectedMirrors);
      assert.equal(result.calls, `grep\n-Fq\nmirror+file:/etc/apt/apt-mirrors.txt\n/etc/apt/sources.list.d/ubuntu.sources\nsudo\ntee\n/etc/apt/apt-mirrors.txt\nnpx\nplaywright\ninstall\n--with-deps\n${browser}\n`);
    }
    for (const browser of ['', 'chrome', 'chromium firefox', 'chromium; exit 0', '$(exit 0)']) {
      const result = run(browser);
      assert.notEqual(result.status, 0);
      assert.equal(result.calls, '', 'Invalid input must fail before any host change or install.');
      assert.equal(result.mirrors, '');
    }
    for (const overrides of [{ GREP_EXIT: '1' }, { SUDO_EXIT: '2' }]) {
      const result = run('webkit', overrides);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.calls, /^npx$/m, 'A failed source guard or mirror write must prevent installation.');
    }
    assert.equal(run('chromium', { NPX_EXIT: '7' }).status, 7, 'Installer failure must fail the action.');
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
