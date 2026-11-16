import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { installJcbUptimeFixture, JCB_UPTIME_LAYOUT, JCB_UPTIME_LAYOUT_SHA256,
  JCB_UPTIME_SOURCE } from './jcb-uptime-fixture.mjs';

const encoder = new TextEncoder();
const markup = `<img src="${JCB_UPTIME_SOURCE}" alt="JCB Powers Uptime">`;
const original = encoder.encode(`<?php /* untouched PHP */ ?>\r\n<a href="https://status.vdm.dev/status/jcb">${markup}</a>\r\n<p>Unchanged content 日本語</p>\n`);
const helperSource = await readFile(new URL('./jcb-uptime-fixture.mjs', import.meta.url), 'utf8');
assert.equal(helperSource.split(JCB_UPTIME_LAYOUT_SHA256).length, 2);

// Exercise the unchanged algorithm against small synthetic bytes without
// vendoring the third-party PHP layout. Only this test module's trusted pin is
// substituted; the actual installed-layout helper has no override parameter.
async function syntheticHelper(bytes = original) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const source = helperSource.replace(JCB_UPTIME_LAYOUT_SHA256, hash);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

function fixture(bytes = original) {
  const state = { owner: 'https://playground.test/__site/owner/session/', bytes: new Uint8Array(bytes), writes: 0, failWrite: false };
  const runtime = {
    get baseUrl() { return state.owner; },
    fs: {
      async readFile(path) { assert.equal(path, JCB_UPTIME_LAYOUT); return state.bytes.slice(); },
      async writeFile(path, bytes) {
        assert.equal(path, JCB_UPTIME_LAYOUT);
        state.writes++;
        if (state.failWrite) { state.failWrite = false; state.bytes = Uint8Array.of(1); throw new Error('Deliberate interrupted write'); }
        state.bytes = new Uint8Array(bytes);
      },
    },
  };
  const page = { async evaluate(callback, argument) {
    const previous = globalThis.window;
    globalThis.window = { playground: runtime };
    try { return await callback(structuredClone(argument)); }
    finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
  } };
  return { page, state };
}

test('the real helper rejects unreviewed layout bytes before any write', async () => {
  const { page, state } = fixture();
  await assert.rejects(installJcbUptimeFixture(page), /Review the changed JCB uptime layout/);
  assert.equal(state.writes, 0);
  assert.deepEqual(state.bytes, original);
});

test('only the exact decorative src changes and original bytes restore before receipt success', async () => {
  const { page, state } = fixture();
  const helper = await syntheticHelper();
  const installed = await helper.installJcbUptimeFixture(page);
  const patched = new TextDecoder().decode(state.bytes);
  const source = /<img src="(data:image\/svg\+xml;base64,[^"]+)" alt="JCB Powers Uptime">/.exec(patched)?.[1];
  assert.ok(source);
  const svg = Buffer.from(source.split(',')[1], 'base64').toString('utf8');
  assert.match(svg, />Uptime fixture<\/text>/);
  assert.doesNotMatch(svg, /\d+\s*%/);
  assert.deepEqual(encoder.encode(patched.replace(source, JCB_UPTIME_SOURCE)), original);
  assert.equal(installed.receipt.sourceURL, JCB_UPTIME_SOURCE);
  assert.match(installed.receipt.reason, /Cloudflare HTTP 403/);
  assert.equal(installed.receipt.restored, false);
  await installed.restore();
  assert.equal(installed.receipt.restored, true);
  assert.deepEqual(state.bytes, original);
  const writes = state.writes;
  await installed.restore();
  assert.equal(state.writes, writes, 'Verified restoration is idempotent.');
});

test('duplicate or changed badge markup fails even when the surrounding fixture hash is reviewed', async () => {
  for (const source of [markup + markup, markup.replace('alt="JCB Powers Uptime"', 'alt="Changed"'),
    markup + '<!-- ' + JCB_UPTIME_SOURCE + ' -->', '<p>No badge</p>']) {
    const bytes = encoder.encode(source), { page, state } = fixture(bytes);
    const helper = await syntheticHelper(bytes);
    await assert.rejects(helper.installJcbUptimeFixture(page), /exactly one reviewed|only in that image/);
    assert.equal(state.writes, 0);
  }
});

test('restoration never overwrites another owner or an independently edited layout', async () => {
  for (const change of ['owner', 'bytes']) {
    const { page, state } = fixture();
    const helper = await syntheticHelper();
    const installed = await helper.installJcbUptimeFixture(page);
    if (change === 'owner') state.owner += 'replacement'; else state.bytes = encoder.encode('edited meanwhile');
    const current = state.bytes.slice(), writes = state.writes;
    await assert.rejects(installed.restore(), /owner was replaced|bytes differ/);
    assert.equal(state.writes, writes);
    assert.deepEqual(state.bytes, current);
    assert.equal(installed.receipt.restored, false);
  }
});

test('an interrupted fixture installation restores the exact original before rejecting', async () => {
  const { page, state } = fixture();
  state.failWrite = true;
  const helper = await syntheticHelper();
  await assert.rejects(helper.installJcbUptimeFixture(page), /Deliberate interrupted write/);
  assert.deepEqual(state.bytes, original);
  assert.equal(state.writes, 2);
});
