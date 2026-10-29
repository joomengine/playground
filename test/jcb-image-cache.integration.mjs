import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { parseCatalog } from '../src/config.mjs';
import { loadDeployCatalog, resolveDeployConfiguration } from '../src/deploys.mjs';
import { guardJcbImageCache } from '../src/jcb-compatibility.mjs';

test('installed JCB 5/6 image cache helpers preserve verified content and repair an unambiguous missing filename', { timeout: 60_000 }, async t => {
  const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion: '8.5' });
  t.after(() => runtime.close());
  const catalog = parseCatalog(runtime.manifest);
  const manifestURL = new URL('assets/manifest.json', runtime.assetBaseUrl);
  const deployCatalog = await loadDeployCatalog({ url: new URL(runtime.manifest.deploys.url, manifestURL), fetcher: runtime.fetchAsset });
  for (const major of ['5', '6']) {
    const release = catalog.joomla.find(entry => entry.version.startsWith(`${major}.`));
    const { configuration } = await resolveDeployConfiguration({ deployId: 'jcb', joomlaVersion: release.version,
      phpVersion: '8.5', admin: { password: `Unused-${crypto.randomUUID()}!` } },
    { catalog, deployCatalog, baseURL: runtime.assetBaseUrl, fetcher: runtime.fetchAsset });
    const response = await runtime.fetchAsset(configuration.extensions[0].url);
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), configuration.extensions[0].sha256);
    const components = unzipSync(bytes, { filter: entry => entry.name.endsWith(`joomla__Component-Builder__${major}.x.zip`) });
    assert.equal(Object.keys(components).length, 1);
    const helperPath = 'component-builder/admin/src/Helper/ComponentbuilderHelper.php';
    const files = unzipSync(Object.values(components)[0], { filter: entry => entry.name === helperPath });
    const source = new TextDecoder().decode(files[helperPath]);
    const patched = guardJcbImageCache(source);
    assert.notEqual(patched, source);
    assert.equal(guardJcbImageCache(patched), patched);
    const method = patched.match(/\tpublic static function getDynamicContent\([\s\S]*?\n\t}\r?\n/)?.[0];
    assert.ok(method, 'The installed helper must retain its recognized method structure.');
    const result = await runtime.runPhp(`<?php
      define('JPATH_ROOT', '/tmp/image-cache-contract');
      class FileHelper {
        public static $remote = false;
        public static $failWrite = false;
        public static function getContent($path, $default) {
          return str_starts_with($path, 'https:') ? self::$remote : (is_file($path) ? file_get_contents($path) : false);
        }
        public static function write($path, $data) { return self::$failWrite ? false : file_put_contents($path, $data); }
      }
      class Folder { public static function create($path) { return mkdir($path, 0777, true); } }
      class Uri { public static function root() { return 'https://site.example/'; } }
      class ComponentbuilderHelper {
        public static $dynamicContent = [];
        public static function getDynamicContentSize($type, $size) { return count(self::$dynamicContent[$type][$size]); }
        ${method}
      }
      function probe($kind) {
        $directory = JPATH_ROOT . '/administrator/components/com_componentbuilder/assets/images/banner/';
        if (!is_dir($directory)) mkdir($directory, 0777, true);
        foreach (glob($directory . '*') as $file) unlink($file);
        $prefix = '[[[ROOT-URL]]]administrator/components/com_componentbuilder/assets/images/banner/';
        $html = '<a href="/keep"><img alt="keep" src="' . $prefix . 'missing.png" width="728"></a>';
        $html .= '<img src="/unrelated.png"><script src="' . $prefix . 'missing.png"></script><img data-src="' . $prefix . 'missing.png">';
        if ($kind === 'ambiguous') $html .= '<img src="' . $prefix . 'second.png">';
        if ($kind === 'nested') $html = str_replace('banner/missing.png', 'banner/nested/missing.png', $html);
        if ($kind === 'correct') $html = str_replace('banner/missing.png', 'banner/verified.png', $html);
        if ($kind === 'quote') $html = str_replace('src="' . $prefix . 'missing.png"', "src='" . $prefix . "missing.png'", $html);
        $bytes = in_array($kind, ['checksum', 'writeFailure'], true) ? 'unverified image' : 'verified image';
        if ($kind !== 'download' && $kind !== 'unreadable') file_put_contents($directory . 'verified.png', $bytes);
        if ($kind === 'existing') file_put_contents($directory . 'missing.png', 'existing image');
        FileHelper::$remote = in_array($kind, ['download', 'writeFailure'], true) ? 'verified image' : ($kind === 'checksum' ? 'unverified image' : false);
        FileHelper::$failWrite = $kind === 'writeFailure';
        $target = ['url' => 'https://remote.example/verified.png', 'hash' => md5('verified image'), 'html' => $html];
        ComponentbuilderHelper::$dynamicContent = ['banner' => ['size' => [$target]]];
        $rendered = ComponentbuilderHelper::getDynamicContent('banner', 'size');
        return ['before' => str_replace('[[[ROOT-URL]]]', Uri::root(), $html), 'after' => $rendered,
          'metadata' => ComponentbuilderHelper::$dynamicContent['banner']['size'][0] === $target,
          'file' => is_file($directory . 'verified.png') ? file_get_contents($directory . 'verified.png') : false];
      }
      $results = [];
      foreach (['cached', 'download', 'existing', 'checksum', 'writeFailure', 'unreadable', 'ambiguous', 'nested', 'correct', 'quote'] as $kind) $results[$kind] = probe($kind);
      echo json_encode($results, JSON_THROW_ON_ERROR);
    `);
    assert.equal(result.status, 200, result.text);
    const proof = JSON.parse(result.text);
    for (const key of ['cached', 'download', 'quote']) {
      assert.equal(proof[key].after, proof[key].before.replace(/(<img alt="keep" src=["'])[^"']+(["'])/,
        '$1https://site.example/administrator/components/com_componentbuilder/assets/images/banner/verified.png$2'), `${major}: ${key}`);
      assert.equal(proof[key].file, 'verified image');
    }
    for (const key of ['existing', 'checksum', 'writeFailure', 'unreadable', 'ambiguous', 'nested', 'correct']) {
      assert.equal(proof[key].after, proof[key].before, `${major}: ${key}`);
    }
    assert.equal(proof.writeFailure.file, 'unverified image', 'A successful download must not certify an older cache file after its write fails.');
    for (const value of Object.values(proof)) assert.equal(value.metadata, true);
  }
});
