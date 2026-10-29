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
    const patched = guardJcbImageTypes(source);
    if (patched !== source) fs.writeFile(filename, patched, { encoding: 'utf8' });
    const current = fs.stat(filename);
    known.set(filename, `${current.size}:${Number(current.mtime)}`);
  }
}
