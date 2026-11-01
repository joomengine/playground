import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { builtManifest } from './runtime-artifacts.mjs';

const manifest = await builtManifest();
const selected = process.env.PLAYGROUND_PHP_VERSIONS?.split(',') || manifest.php.map(entry => entry.version);
for (const phpVersion of selected) {
  test(`PHP ${phpVersion}: Joomla image, archive, XML, Unicode and encryption capabilities`, { timeout: 60_000 }, async t => {
    const runtime = await createNodeRuntime({ phpVersion, phpSettings: { memory_limit: '256M', max_input_vars: 7000 } });
    t.after(() => runtime.close());
    assert.equal(runtime.runtimeInfo.effectivePhpSettings.memory_limit, '256M');
    assert.equal(runtime.runtimeInfo.effectivePhpSettings.max_input_vars, '7000');
    if (phpVersion === '8.4') {
      await runtime.fs.writeFile('/persist/www/diagnostic.php', "<?php trigger_error('Rocket diagnostic contract', E_USER_WARNING); echo 'Clean application body';");
      await runtime.fs.writeFile('/persist/www/diagnostic.txt', 'Static asset');
      const warnings = [];
      const previous = console.warn;
      console.warn = (...values) => warnings.push(values.join(' '));
      try {
        assert.equal(await (await runtime.request('diagnostic.php')).text(), 'Clean application body');
        assert.equal(await (await runtime.request('diagnostic.txt')).text(), 'Static asset');
      } finally { console.warn = previous; }
      assert.equal(warnings.length, 1, 'PHP warnings must be reported once without leaking into HTML or replaying on static requests.');
      assert.match(warnings[0], /Rocket diagnostic contract/);
    }
    const result = await runtime.runPhp(`<?php
      $image = imagecreatetruecolor(4, 3); $color = imagecolorallocate($image, 20, 60, 180); imagefill($image, 0, 0, $color);
      $images = [];
      foreach (['png', 'jpeg', 'webp'] as $format) {
        $file = '/tmp/image.' . $format; $function = 'image' . $format;
        if (!$function($image, $file)) throw new RuntimeException('Cannot encode ' . $format);
        $decoded = imagecreatefromstring(file_get_contents($file));
        $images[$format] = imagesx($decoded) === 4 && imagesy($decoded) === 3;
        unset($decoded); unlink($file);
      }
      unset($image);
      $content = "Package\\0中文 Ελληνικά"; $zip = new ZipArchive();
      if ($zip->open('/tmp/proof.zip', ZipArchive::CREATE) !== true) throw new RuntimeException('Cannot create ZIP.');
      $zip->addFromString('component/data.txt', $content); $zip->close(); $zip->open('/tmp/proof.zip');
      $zipExact = $zip->getFromName('component/data.txt') === $content; $zip->close(); unlink('/tmp/proof.zip');
      $xml = new DOMDocument(); $xml->loadXML('<extension><name>JoomEngine</name></extension>');
      $key = random_bytes(32); $iv = random_bytes(12); $tag = '';
      $cipher = openssl_encrypt($content, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, 'context');
      $plain = openssl_decrypt($cipher, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, 'context');
      $formatter = new NumberFormatter('af_ZA', NumberFormatter::DECIMAL);
      echo json_encode(['php' => PHP_VERSION, 'integerSize' => PHP_INT_SIZE, 'images' => $images, 'zip' => $zipExact,
        'xml' => $xml->getElementsByTagName('name')->item(0)->textContent === 'JoomEngine',
        'simplexml' => (string) simplexml_load_string('<value>中文</value>') === '中文',
        'multibyte' => mb_strlen('中文', 'UTF-8') === 2, 'intl' => is_string($formatter->format(1234.5)),
        'encryption' => $plain === $content, 'authentication' => openssl_decrypt($cipher, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, 'wrong') === false,
        'sodium' => extension_loaded('sodium'), 'mime' => (new finfo(FILEINFO_MIME_TYPE))->buffer('Joomla') === 'text/plain'], JSON_THROW_ON_ERROR);
    `);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(JSON.parse(result.text), { php: manifest.php.find(entry => entry.version === phpVersion).patchVersion,
      integerSize: 8, images: { png: true, jpeg: true, webp: true }, zip: true, xml: true,
      simplexml: true, multibyte: true, intl: true, encryption: true, authentication: true, sodium: true, mime: true });
  });
}
