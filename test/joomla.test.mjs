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
