import { createHash } from 'node:crypto';

export const JCB_SOURCE_OVERLAY = Object.freeze({
  path: 'component-builder/libraries/vendor_jcb/VDM.Joomla/src/Import/Spreadsheet/ChunkReadFilter.php',
  sha256: '742877f73d6817c54963cbc8767c7af805332b561a7c178cae1151147263f28e',
  patchedSha256: '8b8f3e8845eb8844e419c3b05ada2be31eabe911a92365f9bc4e7d7f96cc89c6',
  before: "public function readCell($columnAddress, $row, $worksheetName = '')",
  after: "public function readCell($columnAddress, $row, $worksheetName = ''): bool",
});

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Match JCB's existing boolean implementation to the supported reader interface. */
export function applyJcbCompatibilityOverlay(files) {
  const original = files[JCB_SOURCE_OVERLAY.path];
  if (!(original instanceof Uint8Array) || digest(original) !== JCB_SOURCE_OVERLAY.sha256) {
    throw new Error('The JCB spreadsheet reader differs from the reviewed compatibility source.');
  }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(original);
  if (source.split(JCB_SOURCE_OVERLAY.before).length !== 2) throw new Error('The JCB compatibility method must appear exactly once.');
  const patched = new TextEncoder().encode(source.replace(JCB_SOURCE_OVERLAY.before, JCB_SOURCE_OVERLAY.after));
  if (digest(patched) !== JCB_SOURCE_OVERLAY.patchedSha256) throw new Error('The JCB compatibility result differs from the reviewed patch.');
  return { ...files, [JCB_SOURCE_OVERLAY.path]: patched };
}
