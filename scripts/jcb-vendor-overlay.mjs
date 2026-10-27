import { createHash } from 'node:crypto';

export const JCB_VENDOR_OVERLAYS = Object.freeze([
  Object.freeze({
    path: 'phpoffice/phpspreadsheet/src/PhpSpreadsheet/Writer/Xls/Worksheet.php',
    sha256: '38f8e525b268dec4ec365133dbb10a25a1b84b5da6267ae6937bdd01a8cd754d',
    patchedSha256: 'fafe676a1cbe84744986887e30942141f56413b4a0a757a3171b94dfdaac9db4',
    replacements: Object.freeze([
      Object.freeze({ before: '            0xFFFFFFFF, // unknown data', after: '            -1, // unknown data' }),
      Object.freeze({
        before: '            $objId = 0xFFFFFFFF; // Object identifier of drop down arrow object, or -1 if not visible',
        after: '            $objId = -1; // Object identifier of drop down arrow object, or -1 if not visible',
      }),
    ]),
  }),
  Object.freeze({
    path: 'phpoffice/phpspreadsheet/src/PhpSpreadsheet/Shared/OLE/PPS/Root.php',
    sha256: '3d44f59ad4c9e452f6fbd6669f9041eeb56693b1f72750286aa8909d1109c37b',
    patchedSha256: 'dbe61ccada2f9e9d7c73a17094545b1d63f8daa5c1c6eaac0311eaecf41b6333',
    replacements: Object.freeze([
      Object.freeze({ before: "            fwrite($FILE, pack('V', 0xFFFFFFFD));", after: "            fwrite($FILE, pack('V', -3));" }),
      Object.freeze({ before: "            fwrite($FILE, pack('V', 0xFFFFFFFC));", after: "            fwrite($FILE, pack('V', -4));" }),
    ]),
  }),
  Object.freeze({
    path: 'phpoffice/phpspreadsheet/src/PhpSpreadsheet/Shared/IntOrFloat.php',
    sha256: '9b45a335b5072ba184dcadf0f2df17717862a62f701982aab23c7c51bbdaeb3a',
    patchedSha256: 'd27d4d6fc37364a565213140da177bb330004e68631124d7eca52f1536fe6866',
    replacements: Object.freeze([
      Object.freeze({
        before: '        $iValue = (int) $value;',
        after: '        if (is_float($value) && (!is_finite($value) || $value < PHP_INT_MIN || $value >= -(float) PHP_INT_MIN)) {\n'
          + '            return $value;\n'
          + '        }\n\n'
          + '        $iValue = (int) $value;',
      }),
    ]),
  }),
]);

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Preserve XLS bytes and large numeric values without overflowing PHP integers. */
export function applyJcbVendorOverlay(files) {
  const result = { ...files };
  for (const overlay of JCB_VENDOR_OVERLAYS) {
    const original = files[overlay.path];
    if (!(original instanceof Uint8Array) || digest(original) !== overlay.sha256) {
      throw new Error(`The spreadsheet source differs from its reviewed compatibility input: ${overlay.path}`);
    }
    let source = new TextDecoder('utf-8', { fatal: true }).decode(original);
    for (const { before, after } of overlay.replacements) {
      if (source.split(before).length !== 2) throw new Error(`The spreadsheet packing site must appear exactly once: ${overlay.path}`);
      source = source.replace(before, after);
    }
    const patched = new TextEncoder().encode(source);
    if (digest(patched) !== overlay.patchedSha256) throw new Error(`The spreadsheet compatibility result differs from the reviewed patch: ${overlay.path}`);
    result[overlay.path] = patched;
  }
  return result;
}
