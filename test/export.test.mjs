import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { exportPlaygroundConfiguration, exportSite, normalizeExportOptions } from '../src/export.mjs';

test('portable export validates formats and destination settings', () => {
  assert.equal(normalizeExportOptions().format, 'bundle');
  assert.deepEqual(normalizeExportOptions({ format: 'files', database: { name: 'destination', password: '' } }), {
    format: 'files', database: { name: 'destination', password: '' },
  });
  assert.throws(() => normalizeExportOptions({ format: 'unknown' }), /format/);
  assert.throws(() => normalizeExportOptions({ database: { unexpected: 'value' } }), /Unknown/);
  assert.throws(() => normalizeExportOptions({ database: { password: 'secret\0text' } }), /Invalid/);
  assert.equal(normalizeExportOptions({ includePlaygroundConfiguration: true }).includePlaygroundConfiguration, true);
  assert.equal(normalizeExportOptions({ format: 'files', includePlaygroundConfiguration: true }).includePlaygroundConfiguration, undefined);
  assert.equal(normalizeExportOptions({ format: 'database', includePlaygroundConfiguration: true }).includePlaygroundConfiguration, undefined);
  assert.throws(() => normalizeExportOptions({ includePlaygroundConfiguration: 'yes' }), /boolean/);
});

test('export grants PHP a bounded build allowance below the host deadline and cleans up normally', async () => {
  const calls = [];
  const bytes = new TextEncoder().encode('Exported archive');
  const runtime = {
    fs: { readFile: async () => bytes },
    async runPhp(source, options) {
      const payload = JSON.parse(Buffer.from(/base64_decode\('([^']+)'\)/.exec(source)[1], 'base64'));
      calls.push({ payload, options });
      return { text: '\n__JOOMENGINE_RESULT__' + JSON.stringify({ ok: true,
        path: `${payload.directory}/site.zip`, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), filename: 'site.zip' }) };
    },
  };
  await exportSite(runtime, {}, { sourceLoader: async () => '<?php' });
  assert.equal(calls[0].payload.executionTimeSeconds, 570);
  assert.equal(calls[0].options.timeoutMs, 600_000);
  assert.ok(calls[0].payload.executionTimeSeconds * 1000 < calls[0].options.timeoutMs);
  assert.equal(calls[1].payload.operation, 'cleanup');
  assert.equal(calls[1].payload.executionTimeSeconds, undefined);
  assert.equal(calls[1].options, undefined);
});

test('complete export metadata retains runtime and current credentials without a local site identity', () => {
  const admin = { name: 'Current owner', username: 'site-owner', email: 'owner@example.test', password: 'Same-sandbox-password-123!' };
  const configuration = { deployId: 'blank', sourceDeployId: 'blank', phpVersion: '8.4', joomlaVersion: '6.2.0',
    siteName: 'Edited sandbox', initialPath: '/administrator/', storageKey: 'original-site', fresh: true,
    persistence: true, admin: { ...admin, username: 'previous-owner' },
    extensions: [{ url: 'https://example.test/extension.zip', sha256: 'a'.repeat(64) }], addonExtensions: [],
    startupCommands: [['cache:clean']], addonStartupCommands: [['cache:clean']],
    snapshot: { url: 'https://example.test/prebuilt.zip', sha256: 'b'.repeat(64) } };
  const metadata = exportPlaygroundConfiguration({ configuration, installation: { administrator: admin } });
  assert.equal(metadata.schemaVersion, 1);
  assert.deepEqual(metadata.configuration.admin, admin);
  assert.equal(metadata.configuration.phpVersion, '8.4');
  assert.equal(metadata.configuration.joomlaVersion, '6.2.0');
  assert.deepEqual(metadata.configuration.extensions, configuration.extensions);
  assert.deepEqual(metadata.configuration.startupCommands, configuration.startupCommands);
  assert.equal(metadata.configuration.fresh, false);
  assert.equal('storageKey' in metadata.configuration, false);
  assert.equal('snapshot' in metadata.configuration, false);
  assert.equal(configuration.fresh, true, 'Export must not change the running configuration.');
  assert.throws(() => exportPlaygroundConfiguration({}), /configuration is unavailable/);
});
