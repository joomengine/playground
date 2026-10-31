import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  importJoomlaCheckpoint, parseProvisioningResult, sha256, validateCommand, validateContent, validateInstallOptions, verifyPackage,
} from '../src/joomla/index.mjs';

const configuration = {
  joomlaVersion: '6.2.0',
  admin: { password: 'Local-Demo-Password-123!' },
};

test('installation options preserve command arguments without shell interpretation', () => {
  const argv = ['config:set', 'sitename=A site; $(echo text)'];
  const options = validateInstallOptions({ ...configuration, startupCommands: [argv] });
  assert.deepEqual(options.startupCommands, [argv]);
  assert.equal(options.database, 'joomla');
  assert.equal(options.admin.username, 'admin');
  assert.equal(options.autoLogin, true);
});

test('invalid credentials, database identifiers, versions and command forms are rejected', () => {
  assert.throws(() => validateInstallOptions({ ...configuration, admin: { password: 'short' } }), /password/i);
  assert.throws(() => validateInstallOptions({ ...configuration, database: 'joomla;drop' }), /Database names/);
  assert.throws(() => validateInstallOptions({ ...configuration, joomlaVersion: '6.3.0-beta1' }), /stable Joomla/);
  assert.throws(() => validateCommand('cache:clean'), /array/);
  assert.throws(() => validateCommand(['php cli/joomla.php cache:clean']), /Joomla command name/);
  assert.throws(() => validateCommand(['cache:clean', '\0']), /NUL/);
});

test('extension URLs and optional checksums are validated', () => {
  assert.throws(() => validateInstallOptions({ ...configuration, extensions: [{ url: 'file:///tmp/package.zip' }] }), /HTTP/);
  assert.throws(() => validateInstallOptions({ ...configuration, extensions: [{ url: 'https://user:secret@example.test/file.zip' }] }), /credentials/);
  assert.throws(() => validateInstallOptions({ ...configuration, extensions: [{ url: '/extension.zip', sha256: 'invalid' }] }), /SHA-256/);
  assert.equal(validateInstallOptions({ ...configuration, extensions: [{ url: '/extension.zip', sha256: 'A'.repeat(64) }] }).extensions[0].sha256, 'a'.repeat(64));
});

test('language packages require exact tags and pinned download integrity', () => {
  const language = { tag: 'nl-NL', url: '/packages/nl-NL.zip', sha256: 'A'.repeat(64) };
  const options = validateInstallOptions({ ...configuration, language: 'nl-NL', languages: [language], deployId: 'heritage-demo' });
  assert.equal(options.language, 'nl-NL');
  assert.equal(options.languages[0].sha256, 'a'.repeat(64));
  assert.equal(options.deployId, 'heritage-demo');
  assert.throws(() => validateInstallOptions({ ...configuration, language: '../nl-NL' }), /language tag/);
  assert.throws(() => validateInstallOptions({ ...configuration, languages: [{ ...language, sha256: undefined }] }), /checksum/);
  assert.throws(() => validateInstallOptions({ ...configuration, languages: [{ ...language, url: 'javascript:alert(1)' }] }), /HTTP/);
  assert.throws(() => validateInstallOptions({ ...configuration, deployId: '../demo' }), /identity/);
});

test('multilingual content requires real categories and a unique home in each language', () => {
  const categories = [
    { key: 'english', title: 'English heritage', language: 'en-GB' },
    { key: 'dutch', title: 'Nederlands erfgoed', language: 'nl-NL' },
  ];
  const articles = [
    { key: 'home-en', title: 'Our heritage', language: 'en-GB', category: 'english', home: true, introtext: '<p>Our stories</p>' },
    { key: 'home-nl', title: 'Ons erfgoed', language: 'nl-NL', category: 'dutch', home: true, introtext: '<p>Onze verhalen</p>' },
  ];
  const content = { multilingual: true, categories, articles };
  assert.equal(validateContent(content).articles[1].introtext, '<p>Onze verhalen</p>');
  assert.equal(validateContent(content).articles[0].fulltext, '');
  assert.throws(() => validateContent({ ...content, articles: [{ ...articles[0], category: 'dutch' }, articles[1]] }), /own language/);
  assert.throws(() => validateContent({ ...content, articles: [articles[0]] }), /at least two/);
  assert.throws(() => validateContent({ ...content, articles: [...articles, { ...articles[0], key: 'second-home' }] }), /one home/);
  assert.throws(() => validateContent({ ...content, categories: [...categories, categories[0]] }), /unique/);
  assert.throws(() => validateContent({ ...content, articles: [{ ...articles[0], introtext: 'x'.repeat(32769) }, articles[1]] }), /introduction/);
});

test('package checksum verification detects corrupt downloads before PHP extraction', async () => {
  const archive = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]);
  assert.equal(await sha256(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const digest = await sha256(archive);
  assert.deepEqual(await verifyPackage(archive, digest), archive);
  await assert.rejects(verifyPackage(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 4]), digest), /SHA-256 verification failed/);
  await assert.rejects(verifyPackage(new TextEncoder().encode('<html>')), /ZIP/);
});

test('provisioning accepts only an explicit successful PHP envelope', async () => {
  assert.deepEqual(await parseProvisioningResult({ status: 200, text: '\n__JOOMENGINE_RESULT__{"ok":true,"version":"6.2.0"}' }), { ok: true, version: '6.2.0' });
  await assert.rejects(parseProvisioningResult(new Response('PHP fatal error', { status: 500 })), /did not complete/);
  await assert.rejects(parseProvisioningResult({ status: 200, text: '\n__JOOMENGINE_RESULT__{"ok":false,"error":"Cannot connect to MariaDB"}' }), /Cannot connect to MariaDB/);
  await assert.rejects(parseProvisioningResult({ status: 200, text: '\n__JOOMENGINE_RESULT__{"ok":false,"exitCode":1,"output":"Installer rejected the package"}' }), /Installer rejected/);
  await assert.rejects(parseProvisioningResult({ status: 200, text: '\n__JOOMENGINE_RESULT__{"ok":true}\nFatal error during shutdown' }), /Invalid PHP provisioning response/);
  await assert.rejects(parseProvisioningResult({ status: 500, text: '\n__JOOMENGINE_RESULT__{"ok":true}' }), /HTTP 500 after/);
});


test('private checkpoint import restores without rotating accounts or replaying provisioning', async () => {
  const operations = [];
  const writes = [];
  const archive = new Uint8Array([0x50, 0x4b, 3, 4]);
  const sourceLoader = async name => `<?php\n// operation:${name}\n`;
  const runtime = {
    documentRoot: '/persist/www', installMarkerPath: '/persist/meta/joomla-install.json',
    fs: { writeFile: async (path, bytes) => writes.push({ path, bytes }) },
    runPhp: async source => {
      const operation = [...source.matchAll(/operation:([a-z-]+)/g)].at(-1)[1];
      operations.push(operation);
      return { status: 200, text: '\n__JOOMENGINE_RESULT__' + JSON.stringify(operation === 'status'
        ? { ok: true, marker: null, configured: false, installerPresent: false } : { ok: true }) };
    },
    request: () => { throw new Error('Private restoration must not log in before restoring original sessions.'); },
  };
  const input = { ...configuration, deployId: 'jcb-mcp',
    extensions: [{ url: 'https://example.test/package.zip' }], startupCommands: [['cache:clean']],
    template: { element: 'cassiopeia', url: 'https://example.test/template.zip' } };
  await assert.rejects(importJoomlaCheckpoint(runtime, input, { sourceLoader, archiveBytes: archive, sha256: '0'.repeat(64) }), /SHA-256 verification/);
  assert.equal(writes.length, 0, 'Integrity must be checked before writing or importing.');
  operations.length = 0;
  const result = await importJoomlaCheckpoint(runtime, input, { sourceLoader, archiveBytes: archive, sha256: await sha256(archive) });
  assert.deepEqual(operations, ['status', 'import']);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /^\/tmp\/joomla-checkpoint-/);
  assert.equal(result.fromCheckpoint, true);
  assert.equal(result.resumed, true);
});

test('failure envelope survives Joomla fatal HTML while keeping diagnostics bounded and private', async () => {
  const text = '\n__JOOMENGINE_RESULT__' + JSON.stringify({ ok: false, error: 'Maximum execution time of 60 seconds exceeded',
    output: 'https://user:private@example.test/pkg.zip?token=secret\n{"password":"sensitive"}' }) + '<!DOCTYPE html><style>' + 'x'.repeat(12000) + '</style>';
  await assert.rejects(parseProvisioningResult({ status: 500, text }), error => {
    assert.equal(error.message, 'Maximum execution time of 60 seconds exceeded');
    assert.ok(error.technicalDetails.length <= 8192);
    assert.match(error.technicalDetails, /<!DOCTYPE html>/);
    assert.doesNotMatch(error.technicalDetails, /private|sensitive|token=secret/);
    return true;
  });
});

test('JSON framing handles quotes, nesting, Unicode and marker text inside strings', async () => {
  const result = { ok: true, output: 'Quoted " braces } { ☃ \n__JOOMENGINE_RESULT__', nested: [{ brackets: '[{}]' }] };
  assert.deepEqual(await parseProvisioningResult({ status: 200, text: '\n__JOOMENGINE_RESULT__' + JSON.stringify(result) }), result);
  const failed = { ...result, ok: false, error: 'Known failure' };
  await assert.rejects(parseProvisioningResult({ text: '\n__JOOMENGINE_RESULT__' + JSON.stringify(failed) + '<html>Fatal error</html>' }), /Known failure/);
});

test('malformed, truncated, conflicting and worker-failed results never become success', async () => {
  const marker = '\n__JOOMENGINE_RESULT__';
  for (const text of ['{}', '{"ok":"true"}', '[{"ok":true}]', '{"ok":true', '{"ok":true] ',
    '{"ok":true}<!DOCTYPE html>', '{"ok":false,"error":"failed"}' + marker + '{"ok":true}',
    '{"ok":true}' + marker + '{"ok":false}', '{"ok":true}' + marker + '{"ok":true}']) {
    await assert.rejects(parseProvisioningResult({ status: 200, text: marker + text }), /Invalid PHP provisioning response/);
  }
  for (const extra of [{ fatal: true }, { error: 'Worker died' }, { failed: true }, { diagnostic: 'PHP restarted after an application error.' }]) {
    await assert.rejects(parseProvisioningResult({ status: 200, text: marker + '{"ok":true}', ...extra }), /PHP failed/);
  }
  await assert.rejects(parseProvisioningResult({ text: '<!DOCTYPE html><style>body{color:red}</style>' }), error => {
    assert.doesNotMatch(error.message, /DOCTYPE|style|color/);
    return true;
  });
});

test('extension installer applies matching PHP and host budgets before any work', async () => {
  const { installExtension, runStartupCommand } = await import('../src/joomla/index.mjs');
  const sourceLoader = async name => `<?php\n// operation:${name}\n`;
  const calls = [], writes = [];
  const runtime = { fs: { writeFile: async (...args) => writes.push(args) }, runPhp: async (source, options) => {
    const payload = JSON.parse(Buffer.from(/base64_decode\('([^']+)'\)/.exec(source)[1], 'base64'));
    calls.push({ payload, options });
    return { status: 200, text: '\n__JOOMENGINE_RESULT__{"ok":true}' };
  } };
  const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
  await assert.rejects(installExtension(runtime, bytes, { sourceLoader, executionTimeSeconds: 300, timeoutMs: 180000 }), /Installation timeout/);
  assert.equal(writes.length, 0);
  assert.equal(calls.length, 0);
  await installExtension(runtime, bytes, { sourceLoader });
  assert.equal(calls[0].payload.installationExecutionTimeSeconds, 180);
  assert.equal(calls[0].options.timeoutMs, 210000);
  await installExtension(runtime, bytes, { sourceLoader, executionTimeSeconds: 300, timeoutMs: 400000 });
  assert.equal(calls[1].payload.installationExecutionTimeSeconds, 300);
  assert.equal(calls[1].options.timeoutMs, 400000);
  await runStartupCommand(runtime, ['extension:install', '--path=/tmp/package.zip'], { sourceLoader });
  assert.equal(calls[2].payload.installationExecutionTimeSeconds, 180);
  await runStartupCommand(runtime, ['cache:clean'], { sourceLoader });
  assert.equal(calls[3].payload.installationExecutionTimeSeconds, undefined);
  assert.equal(calls[3].options, undefined);
});

test('installer errors identify package, phase and deadline without exposing HTML or URL secrets', async () => {
  const { installExtension } = await import('../src/joomla/index.mjs');
  const bytes = new Uint8Array([0x50, 0x4b, 3, 4]);
  let calls = 0;
  const runtime = { fs: { writeFile: async () => {} }, runPhp: async () => {
    calls++;
    return { status: 500, text: '\n__JOOMENGINE_RESULT__{"ok":false,"error":"Maximum execution time of 180 seconds exceeded"}<!DOCTYPE html>' };
  } };
  await assert.rejects(installExtension(runtime, bytes, { sourceLoader: async () => '<?php', packageUrl: 'https://example.test/package.zip?token=secret' }), error => {
    assert.match(error.message, /package.zip installation exceeded PHP's 180-second limit/);
    assert.doesNotMatch(error.message, /DOCTYPE|secret/);
    assert.equal(error.packageUrl, 'https://example.test/package.zip');
    assert.equal(error.phase, 'installation');
    assert.equal(error.incomplete, true);
    assert.equal(error.executionTimeSeconds, 180);
    return true;
  });
  assert.equal(calls, 1, 'A partially completed install must never be replayed.');
});

test('applying packages distinguishes unreadable downloads, verification and installer work', async () => {
  const { applyJoomlaConfiguration } = await import('../src/joomla/index.mjs');
  const sourceLoader = async name => `<?php\n// operation:${name}\n`;
  const writes = [], progress = [], calls = [];
  const runtime = { fs: { writeFile: async (...args) => writes.push(args) }, runPhp: async (source, options) => {
    const payload = JSON.parse(Buffer.from(/base64_decode\('([^']+)'\)/.exec(source)[1], 'base64'));
    calls.push({ payload, options });
    return { status: 200, text: '\n__JOOMENGINE_RESULT__' + JSON.stringify(calls.length === 1
      ? { ok: true, marker: { state: 'complete', joomlaVersion: '6.2.0' }, configured: true, installerPresent: false }
      : { ok: false, error: 'Installer failed' }) };
  } };
  const config = { ...configuration, extensions: [{ url: 'https://example.test/extension.zip?key=private' }] };
  await assert.rejects(applyJoomlaConfiguration(runtime, config, { sourceLoader, progress: event => progress.push(event),
    fetchPackage: async () => { throw new TypeError('Failed to fetch'); } }), error => {
    assert.equal(error.phase, 'download');
    assert.match(error.message, /browser could not read/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(writes.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(progress.at(-1).phase, 'download');
  calls.length = 0; progress.length = 0;
  await assert.rejects(applyJoomlaConfiguration(runtime, config, { sourceLoader, progress: event => progress.push(event),
    fetchPackage: async () => new Response(new Uint8Array([0x50, 0x4b, 3, 4])) }), /Installer failed/);
  assert.deepEqual(progress.filter(event => event.phase).map(event => event.phase), ['download', 'verification', 'installation']);
  assert.equal(calls.at(-1).payload.installationExecutionTimeSeconds, 180);
  assert.equal(calls.at(-1).options.timeoutMs, 210000);
  assert.equal(writes.length, 1, 'Failure must not rewrite the complete marker or replay installation.');
});
