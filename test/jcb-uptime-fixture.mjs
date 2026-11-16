import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const JCB_UPTIME_SOURCE = 'https://status.vdm.dev/api/badge/25/uptime?labelPrefix=JCB+Powers+';
export const JCB_UPTIME_LAYOUT = '/persist/www/administrator/components/com_componentbuilder/layouts/jcbsupportmessage.php';
// Identical original layout in the pinned JCB 5.2.0 and 6.2.0 distributions.
export const JCB_UPTIME_LAYOUT_SHA256 = '648cb91049837b53d4b0f0cbddd268582fd3aa70e14cec84050fe0f362ef9b14';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const markup = `<img src="${JCB_UPTIME_SOURCE}" alt="JCB Powers Uptime">`;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="168" height="24" role="img" aria-label="Uptime fixture"><rect width="168" height="24" fill="#555"/><text x="84" y="16" text-anchor="middle" font-family="sans-serif" font-size="12" fill="white">Uptime fixture</text></svg>';
const fixtureSource = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');

/** Only this decorative image is substituted; no live uptime value is claimed. */
export async function installJcbUptimeFixture(page) {
  const read = () => page.evaluate(async path => ({
    owner: window.playground.baseUrl,
    bytes: Array.from(await window.playground.fs.readFile(path)),
  }), JCB_UPTIME_LAYOUT);
  const initial = await read();
  const original = Uint8Array.from(initial.bytes);
  assert.equal(digest(original), JCB_UPTIME_LAYOUT_SHA256, 'Review the changed JCB uptime layout before using its test fixture.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(original);
  assert.equal(source.split(markup).length, 2, 'The pinned layout must contain exactly one reviewed uptime image.');
  assert.equal(source.split(JCB_UPTIME_SOURCE).length, 2, 'The uptime source URL must occur only in that image.');
  const replacement = new TextEncoder().encode(source.replace(markup,
    `<img src="${fixtureSource}" alt="JCB Powers Uptime">`));
  const replacementHash = digest(replacement);
  const receipt = {
    sourceURL: JCB_UPTIME_SOURCE, layout: JCB_UPTIME_LAYOUT, originalSha256: JCB_UPTIME_LAYOUT_SHA256,
    fixtureSha256: replacementHash, label: 'Uptime fixture', restored: false,
    reason: 'The external decorative uptime image returned a Cloudflare HTTP 403 challenge. Compiler and mail acceptance do not measure this service uptime.',
  };
  const write = bytes => page.evaluate(async ({ owner, path, bytes }) => {
    if (window.playground.baseUrl !== owner) throw new Error('The JCB uptime fixture owner was replaced.');
    await window.playground.fs.writeFile(path, Uint8Array.from(bytes));
  }, { owner: initial.owner, path: JCB_UPTIME_LAYOUT, bytes: Array.from(bytes) });
  const verify = async hash => {
    const current = await read();
    assert.equal(current.owner, initial.owner, 'The JCB uptime fixture owner was replaced.');
    assert.equal(digest(Uint8Array.from(current.bytes)), hash, 'The JCB uptime layout bytes differ from the expected scoped fixture.');
  };
  try {
    await write(replacement);
    await verify(replacementHash);
  } catch (error) {
    try { await write(original); await verify(JCB_UPTIME_LAYOUT_SHA256); }
    catch (restoreError) { throw new AggregateError([error, restoreError], 'Installing the JCB uptime fixture and restoring its original layout both failed.', { cause: error }); }
    throw error;
  }
  return {
    receipt,
    async restore() {
      if (receipt.restored) return;
      await verify(replacementHash);
      await write(original);
      await verify(JCB_UPTIME_LAYOUT_SHA256);
      receipt.restored = true;
    },
  };
}
