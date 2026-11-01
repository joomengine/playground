import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { builtWrapper, runtimeConfiguration, releasedLibraries } from './runtime-artifacts.mjs';
import { stageSodium } from '../scripts/sodium.mjs';
import { runtimeRandomValue } from '../src/php-settings.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pins = await runtimeConfiguration();
const directory = path.resolve(root, process.env.SODIUM_EXTENSION_DIR || '.cache/sodium');
const selected = process.env.PLAYGROUND_PHP_VERSIONS?.split(',');
for (const version of pins.php.filter(value => !selected || selected.includes(value.version))) {
  test(`PHP ${version.version}: native sodium encrypts, authenticates and signs with secure entropy`, { timeout: 60_000 }, async t => {
    const destination = await mkdtemp(path.join(tmpdir(), 'rocket-sodium-'));
    t.after(() => rm(destination, { recursive: true, force: true }));
    const record = await stageSodium({ directory, destination, version, upstream: pins.upstream });
    const { PhpCgiNode } = await builtWrapper(version.version);
    const php = new PhpCgiNode({ version: version.version, persist: [], docroot: '/www', prefix: '/',
      phpArgs: { getRandomValue: runtimeRandomValue },
      sharedLibs: [...await releasedLibraries(version.version), { name: record.provenance.extension.file, url: pathToFileURL(path.join(destination, record.provenance.extension.file)).href, ini: true }],
      ini: 'display_errors=1\n',
    });
    await php.mkdir('/config'); await php.mkdir('/www');
    await php.writeFile('/www/index.php', `<?php
      $message = "JoomEngine\\0" . hex2bin('ff0080') . ' Ελληνικά 中文';
      $key = sodium_crypto_secretbox_keygen(); $other = sodium_crypto_secretbox_keygen();
      $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
      $cipher = sodium_crypto_secretbox($message, $nonce, $key);
      $tampered = $cipher; $tampered[0] = chr(ord($tampered[0]) ^ 1);
      $pair = sodium_crypto_sign_keypair();
      $signature = sodium_crypto_sign_detached($message, sodium_crypto_sign_secretkey($pair));
      $aeadNonce = random_bytes(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
      $aead = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt($message, 'context', $aeadNonce, $key);
      $variant = SODIUM_BASE64_VARIANT_ORIGINAL;
      $base64 = sodium_bin2base64($message, $variant);
      $overflowVariant = 4294967296 + $variant;
      $variantRejected = [];
      foreach ([static fn() => sodium_bin2base64($message, $overflowVariant),
        static fn() => sodium_base642bin($base64, $overflowVariant)] as $invalid) {
        try { $invalid(); $variantRejected[] = false; }
        catch (SodiumException $exception) { $variantRejected[] = true; }
      }
      $ops = SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE;
      $memory = SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE;
      $hash = sodium_crypto_pwhash_str('runtime contract', $ops, $memory);
      $memoryRejected = [];
      foreach ([4294967296 + $memory, -4294967296 + $memory] as $invalidMemory) {
        try { sodium_crypto_pwhash_str_needs_rehash($hash, $ops, $invalidMemory); $memoryRejected[] = false; }
        catch (SodiumException $exception) { $memoryRejected[] = true; }
      }
      echo json_encode(['php' => PHP_VERSION, 'intSize' => PHP_INT_SIZE, 'sodium' => extension_loaded('sodium'), 'library' => SODIUM_LIBRARY_VERSION,
        'base64' => sodium_base642bin($base64, $variant) === $message,
        'variantRejected' => $variantRejected, 'memoryRejected' => $memoryRejected,
        'rehash' => sodium_crypto_pwhash_str_needs_rehash($hash, $ops, $memory),
        'secretbox' => sodium_crypto_secretbox_open($cipher, $nonce, $key) === $message,
        'tamperRejected' => sodium_crypto_secretbox_open($tampered, $nonce, $key) === false,
        'independentKeys' => strlen($key) === 32 && $key !== $other,
        'signature' => sodium_crypto_sign_verify_detached($signature, $message, sodium_crypto_sign_publickey($pair)),
        'signatureRejectsChange' => !sodium_crypto_sign_verify_detached($signature, $message . '!', sodium_crypto_sign_publickey($pair)),
        'aead' => sodium_crypto_aead_xchacha20poly1305_ietf_decrypt($aead, 'context', $aeadNonce, $key) === $message,
        'contextRejected' => sodium_crypto_aead_xchacha20poly1305_ietf_decrypt($aead, 'wrong', $aeadNonce, $key) === false,
        'hash' => strlen(sodium_crypto_generichash($message)) === 32], JSON_THROW_ON_ERROR);
    `);
    const response = await php.request({ url: '/index.php', method: 'GET', headers: { host: 'localhost' } });
    const body = await response.text(); assert.equal(response.status, 200, body);
    assert.deepEqual(JSON.parse(body), { php: version.patchVersion, intSize: 8, sodium: true,
      library: record.provenance.sodiumSource.version, base64: true, variantRejected: [true, true], memoryRejected: [true, true], rehash: false, secretbox: true,
      tamperRejected: true, independentKeys: true, signature: true, signatureRejectsChange: true, aead: true, contextRejected: true, hash: true });
  });
}
