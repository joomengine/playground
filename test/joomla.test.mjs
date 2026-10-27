import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseProvisioningResult, sha256, validateCommand, validateInstallOptions, verifyPackage,
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
