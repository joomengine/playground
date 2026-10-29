import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardJcbImageTypes, guardJcbImageCache, applyJcbRuntimeCompatibility } from '../src/jcb-compatibility.mjs';

const helper = `<?php
class ComponentbuilderHelper {
  public static function imageInfo($path, $request = 'type') {
    $result = getimagesize($path);
    switch ($request) {
      case 'width': return $result[0];
      case 'type':
        $extensions = array(IMAGETYPE_PNG => "png", IMAGETYPE_JPEG => "jpg", IMAGETYPE_SWC => "swc");
        return $extensions[$result[2]];
    }
  }
  public static function unrelated() { return 'unchanged'; }
}`;

test('optional image identifiers are guarded without defining unsupported decoder capabilities', () => {
  const patched = guardJcbImageTypes(helper);
  assert.notEqual(patched, helper);
  assert.match(patched, /\\defined\(\$imageType\)/);
  assert.match(patched, /'IMAGETYPE_SWC' => "swc"/);
  assert.doesNotMatch(patched, /(?<!d)\\define\(/);
  assert.match(patched, /case 'width': return \$result\[0\];/);
  assert.match(patched, /return \$extensions\[\$result\[2\]\];/);
  assert.equal(guardJcbImageTypes(patched), patched, 'Repeated requests must not rewrite the helper.');
  assert.equal(guardJcbImageTypes(helper.replaceAll('\n', '\r\n')).replaceAll('\r\n', '\n'), patched);
});

const cache = `public static function getDynamicContent($type, $size) {
  $target = self::$dynamicContent[$type][$size][$get];
  $path = JPATH_ROOT . "/administrator/components/com_componentbuilder/assets/images/$type/$file_name";
  if (($image_data = FileHelper::getContent($target['url'], false)) !== false && md5($image_data) === $target['hash']) {
    FileHelper::write($path, $image_data);
  }
  return str_replace('[[[ROOT-URL]]]', Uri::root(), $target['html']);
}`;

test('missing image caches use only the original HTTPS image source after an unreadable download', () => {
  const patched = guardJcbImageCache(cache);
  assert.notEqual(patched, cache);
  assert.match(patched, /\$image_data === false && !is_file\(\$path\)/);
  assert.match(patched, /htmlspecialchars\(\$remote, ENT_QUOTES \| ENT_SUBSTITUTE, 'UTF-8'\)/);
  assert.match(patched, /=== 'https'/);
  assert.match(patched, /!isset\(\$parts\['user'\]\)/);
  assert.match(patched, /!isset\(\$parts\['pass'\]\)/);
  assert.ok(patched.includes("(<img\\b[^>]*?\\ssrc"));
  assert.doesNotMatch(patched, /https:\/\//, 'The fallback must not carry its own URL or host list.');
  assert.equal(guardJcbImageCache(patched), patched);
  assert.equal(guardJcbImageCache(cache.replaceAll('\n', '\r\n')).replaceAll('\r\n', '\n'), patched);
});

test('a mismatched cache filename is corrected only for one missing image backed by verified bytes', () => {
  const patched = guardJcbImageCache(cache);
  assert.match(patched, /preg_match_all\([^\n]+\) === 1/);
  assert.match(patched, /\$referenced_path !== \$path && !file_exists\(\$referenced_path\)/);
  assert.match(patched, /\$image_data !== false && md5\(\$image_data\) === \$target\['hash'\]/);
  assert.match(patched, /is_file\(\$path\) && md5_file\(\$path\) === \$target\['hash'\]/);
  assert.match(patched, /substr_replace\(\$target\['html'\]/);
  assert.match(patched, /\$cache_directory \. basename\(\$path\)/);
  assert.doesNotMatch(patched, /\$target\['(?:url|hash|html)'\]\s*=/);
  const previous = patched.replace(/\/\/ Rocket: use the verified cache filename[\s\S]*?(?=return str_replace\('\[\[\[ROOT-URL\]\]\]', Uri::root\(\), \$target\['html'\]\);)/, '');
  assert.notEqual(previous, patched);
  assert.equal(guardJcbImageCache(previous), patched, 'Saved helpers with the previous read guard must gain the cache correction once.');
  assert.equal((guardJcbImageCache(previous).match(/\/\/ Rocket: a failed image read/g) ?? []).length, 1);
});

test('unknown image cache structures are never rewritten', () => {
  for (const source of [cache.replace('getDynamicContent', 'otherMethod'), cache.replace("md5($image_data)", 'customCheck($image_data)'),
    cache.replace("$target['url']", "$other['url']"), cache.replace('$path = JPATH_ROOT', '$path = OTHER_ROOT'),
    cache.replace("Uri::root()", "Uri::base()"), '<?php class ComponentbuilderHelper {}']) {
    assert.equal(guardJcbImageCache(source), source);
  }
});

test('changed helper structure or computed image maps are left untouched', () => {
  for (const source of [helper.replace('imageInfo', 'otherMethod'),
    helper.replace('IMAGETYPE_PNG', 'computeImageType()'),
    helper.replace('array(IMAGETYPE_PNG', 'array($custom => "custom", IMAGETYPE_PNG'),
    '<?php class ComponentbuilderHelper {}']) {
    assert.equal(guardJcbImageTypes(source), source);
  }
});

test('runtime compatibility rechecks installed updates but does not reread unchanged files', () => {
  const filename = '/persist/www/administrator/components/com_componentbuilder/src/Helper/ComponentbuilderHelper.php';
  let source = helper;
  let modified = 1;
  let reads = 0;
  let writes = 0;
  const binary = { FS: {
    analyzePath: name => ({ exists: name === filename, object: { mode: 1 } }),
    isFile: mode => mode === 1,
    stat: () => ({ size: source.length, mtime: new Date(modified) }),
    readFile: () => { reads++; return source; },
    writeFile: (name, value) => { assert.equal(name, filename); writes++; source = value; modified++; },
  } };
  applyJcbRuntimeCompatibility(binary, '/internal');
  assert.equal(reads, 0);
  applyJcbRuntimeCompatibility(binary, '/persist/www');
  const patched = source;
  applyJcbRuntimeCompatibility(binary, '/persist/www');
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  source = helper; modified++;
  applyJcbRuntimeCompatibility(binary, '/persist/www');
  assert.equal(source, patched);
  assert.equal(writes, 2);
});
