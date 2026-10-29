const helpers = Object.freeze([
  'administrator/components/com_componentbuilder/src/Helper/ComponentbuilderHelper.php',
  'administrator/components/com_componentbuilder/helpers/componentbuilder.php',
]);
const fingerprints = new WeakMap();

/** Keep JCB's image suffixes while ignoring image formats absent from this PHP build. */
export function guardJcbImageTypes(source) {
  const method = /\bpublic\s+static\s+function\s+imageInfo\s*\(/.exec(source);
  if (!method) return source;
  const remainder = source.slice(method.index);
  const next = /\b(?:public|protected|private)\s+(?:static\s+)?function\s+/.exec(remainder.slice(method[0].length));
  const end = next ? method.index + method[0].length + next.index : source.length;
  const body = source.slice(method.index, end);
  // Accept only a literal image-type map, never arbitrary PHP expressions.
  const pattern = /\$extensions\s*=\s*array\s*\(\s*((?:\\?IMAGETYPE_[A-Z0-9_]+\s*=>\s*['"][a-z0-9]+['"]\s*,?\s*)+)\)\s*;/g;
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1) return source;
  const [match] = matches;
  const entries = [...match[1].matchAll(/\\?(IMAGETYPE_[A-Z0-9_]+)\s*=>\s*(['"][a-z0-9]+['"])/g)];
  if (!entries.length) return source;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const replacement = [
    '$extensions = [];',
    '// Rocket: image identifiers do not imply that this PHP build has their decoders.',
    `foreach ([${entries.map(([, name, suffix]) => `'${name}' => ${suffix}`).join(', ')}] as $imageType => $suffix) {`,
    '    if (\\defined($imageType)) { $extensions[\\constant($imageType)] = $suffix; }',
    '}',
  ].join(newline);
  const offset = method.index + match.index;
  return source.slice(0, offset) + replacement + source.slice(offset + match[0].length);
}

/** Display an unreadable remote image directly instead of emitting a nonexistent cache URL. */
export function guardJcbImageCache(source) {
  const method = /\bpublic\s+static\s+function\s+getDynamicContent\s*\(/.exec(source);
  if (!method) return source;
  const remainder = source.slice(method.index);
  const next = /\b(?:public|protected|private)\s+(?:static\s+)?function\s+/.exec(remainder.slice(method[0].length));
  const end = next ? method.index + method[0].length + next.index : source.length;
  const body = source.slice(method.index, end);
  if (body.includes('// Rocket: a failed image read')) return source;
  // Recognize the cache contract, not a particular package version or asset list.
  if (!/\$target\s*=\s*self::\$dynamicContent\[\$type\]\[\$size\]\[\$get\]\s*;/.test(body)
      || !/\$path\s*=\s*JPATH_ROOT\s*\.\s*"\/administrator\/components\/com_componentbuilder\/assets\/images\/\$type\/\$file_name"\s*;/.test(body)
      || !/\(\$image_data\s*=\s*FileHelper::getContent\(\$target\['url'\],\s*false\)\)\s*!==\s*false\s*&&\s*md5\(\$image_data\)\s*===\s*\$target\['hash'\]/.test(body)) return source;
  const returns = [...body.matchAll(/return\s+str_replace\('\[\[\[ROOT-URL\]\]\]',\s*Uri::root\(\),\s*\$target\['html'\]\)\s*;/g)];
  if (returns.length !== 1) return source;
  const [returned] = returns;
  const fallback = String.raw`// Rocket: a failed image read must not invent a cached file.
                if ($image_data === false && !is_file($path)) {
                    $remote = $target['url'];
                    $parts = parse_url($remote);
                    if (is_array($parts) && strtolower($parts['scheme'] ?? '') === 'https'
                        && !empty($parts['host']) && !isset($parts['user']) && !isset($parts['pass'])
                        && !preg_match('~[\x00-\x20\x7f]~', $remote)) {
                        $local = '[[[ROOT-URL]]]' . ltrim(substr($path, strlen(JPATH_ROOT)), '/');
                        $pattern = '~(<img\b[^>]*?\ssrc\s*=\s*)([\x22\x27])' . preg_quote($local, '~') . '\2~i';
                        $html = preg_replace_callback($pattern, static function ($image) use ($remote) {
                            return $image[1] . $image[2] . htmlspecialchars($remote, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . $image[2];
                        }, $target['html']);
                        return str_replace('[[[ROOT-URL]]]', Uri::root(), $html);
                    }
                }
                `;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const offset = method.index + returned.index;
  return source.slice(0, offset) + fallback.replaceAll('\n', newline) + source.slice(offset);
}

/** Reapply after an extension update; unchanged files cost only two filesystem stats. */
export function applyJcbRuntimeCompatibility(binary, documentRoot) {
  if (documentRoot !== '/persist/www') return;
  const fs = binary.FS;
  let known = fingerprints.get(fs);
  if (!known) { known = new Map(); fingerprints.set(fs, known); }
  for (const relative of helpers) {
    const filename = `${documentRoot}/${relative}`;
    const info = fs.analyzePath(filename);
    if (!info.exists || !fs.isFile(info.object.mode)) { known.delete(filename); continue; }
    const stat = fs.stat(filename);
    const fingerprint = `${stat.size}:${Number(stat.mtime)}`;
    if (known.get(filename) === fingerprint) continue;
    const source = fs.readFile(filename, { encoding: 'utf8' });
    const patched = guardJcbImageCache(guardJcbImageTypes(source));
    if (patched !== source) fs.writeFile(filename, patched, { encoding: 'utf8' });
    const current = fs.stat(filename);
    known.set(filename, `${current.size}:${Number(current.mtime)}`);
  }
}
