import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = fileURLToPath(new URL('../', import.meta.url));

for (const fixture of ['deployment-editor.browser.mjs', 'structured-inputs.browser.mjs']) {
  test(`${fixture} selects Firefox and exits after a failed browser launch`, () => {
    const env = { ...process.env,
      PLAYGROUND_BROWSERS: 'firefox',
      PLAYGROUND_FIREFOX_EXECUTABLE: `/missing-playground-fixture-${process.pid}/firefox`,
      PLAYGROUND_CHROMIUM_EXECUTABLE: `/missing-playground-fixture-${process.pid}/chromium`,
    };
    delete env.NODE_TEST_CONTEXT;
    // Run the fixture in one process so a leaked HTTP server keeps it alive.
    // The missing executable deliberately exercises cleanup without a browser.
    const result = spawnSync(process.execPath, [`test/${fixture}`], {
      cwd: directory, env, encoding: 'utf8', timeout: 10_000,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.equal(result.error, undefined, `The fixture did not exit after failed startup: ${output}`);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, output);
    assert.match(output, /\(firefox\)/);
    assert.ok(output.includes(env.PLAYGROUND_FIREFOX_EXECUTABLE), output);
    assert.ok(!output.includes(env.PLAYGROUND_CHROMIUM_EXECUTABLE), output);
  });
}
