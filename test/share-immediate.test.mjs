import assert from 'node:assert/strict';
import test from 'node:test';
import { createShareURL, readURLConfiguration } from '../src/config.mjs';

test('immediate deployment round-trips separately from simple and full deployment data', () => {
  for (const configuration of [
    { deployId: 'blank', siteName: 'Shared site', phpVersion: '8.4' },
    { deployId: 'blank', siteName: 'Full recipe', phpSettings: { memory_limit: '512M' } },
  ]) {
    const normal = createShareURL('https://playground.test/?immediate=1&secret=private', configuration);
    const checked = createShareURL('https://playground.test/', configuration, { immediate: true });
    const unchecked = createShareURL(checked, configuration, { immediate: false });
    assert.equal(new URL(normal).searchParams.has('immediate'), false);
    assert.equal(new URL(checked).searchParams.get('immediate'), '1');
    assert.equal(unchecked, normal);
    const selected = readURLConfiguration(checked);
    assert.equal(selected.immediate, true);
    assert.equal(selected.autostart, true);
    assert.deepEqual(selected.config, readURLConfiguration(normal).config);
    assert.equal(Object.hasOwn(selected.config, 'immediate'), false);
    assert.equal(readURLConfiguration(normal).immediate, false);
    assert.doesNotMatch(checked, /private|secret/);
  }
});

test('the immediate URL flag uses strict boolean parsing and never overrides start=0', () => {
  for (const value of ['1', 'true', 'yes', 'TRUE']) {
    const parsed = readURLConfiguration(`https://playground.test/?immediate=${value}`);
    assert.equal(parsed.immediate, true);
    assert.equal(parsed.autostart, true);
    assert.equal(readURLConfiguration(`https://playground.test/?immediate=${value}&start=0`).autostart, false);
  }
  for (const value of ['0', 'false', 'no', 'FALSE']) {
    assert.equal(readURLConfiguration(`https://playground.test/?immediate=${value}&start=1`).immediate, false);
  }
  for (const value of ['', '2', 'later', 'null']) {
    assert.throws(() => readURLConfiguration(`https://playground.test/?immediate=${value}`), /immediate must be/);
  }
  assert.throws(() => createShareURL('https://playground.test/', {}, { immediate: 'false' }), /must be a boolean/);
});

test('immediate links retain configuration validation and do not export the launch option into a recipe', () => {
  assert.throws(() => createShareURL('https://playground.test/', {
    startupCommands: [['user:add', '--password=private']],
  }, { immediate: true }), /secrets/);
  assert.throws(() => readURLConfiguration('https://playground.test/?immediate=1&extension=javascript:alert(1)'), /HTTP/i);
});
