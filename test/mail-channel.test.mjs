import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailCaptureClient, replyToMailCapture, requireMailCapture, SENDMAIL_INI } from '../src/mail/channel.mjs';

test('capture waits for literal owner acceptance and preserves forwarded identity', async () => {
  const packets = [];
  const client = createMailCaptureClient({ postMessage: packet => packets.push(packet) });
  let settled = false;
  const event = { raw: Uint8Array.of(0, 255) };
  const result = client.capture(event, 'origin-worker:17').then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(packets[0].captureId, 'origin-worker:17');
  assert.equal(packets[0].payload, event);
  assert.equal(client.receive({ type: 'database-result', id: packets[0].id }), false);
  assert.equal(client.receive({ type: 'mail-result', id: 'unknown', value: true }), true);
  assert.equal(settled, false);
  client.receive({ type: 'mail-result', id: packets[0].id, value: true });
  assert.equal(await result, true);
  client.close();
});

test('non-true replies, explicit owner errors, postMessage errors, timeout and closure reject', async () => {
  for (const reply of [{ value: false }, { value: {} }, { value: 1 }, { error: 'Inbox unavailable' }, { value: true, error: 'failure' }]) {
    let packet;
    const client = createMailCaptureClient({ postMessage: value => { packet = value; } });
    const result = client.capture({});
    client.receive({ type: 'mail-result', id: packet.id, ...reply });
    await assert.rejects(result);
    client.close();
  }
  const failed = createMailCaptureClient({ postMessage() { throw new Error('DataCloneError'); } });
  await assert.rejects(failed.capture({}), /DataCloneError/);
  failed.close();
  const timeout = createMailCaptureClient({ postMessage() {}, timeoutMs: 5 });
  await assert.rejects(timeout.capture({}), /acknowledge/);
  timeout.close();
  const closed = createMailCaptureClient({ postMessage() {} });
  const pending = [closed.capture({}), closed.capture({})];
  closed.close(new Error('Worker exited'));
  await Promise.all(pending.map(result => assert.rejects(result, /Worker exited/)));
  await assert.rejects(closed.capture({}), /Worker exited/);
});

test('independent clients never collide; forwarding ACK waits through nested owner', async () => {
  const packets = [];
  const first = createMailCaptureClient({ postMessage: packet => packets.push(packet) });
  const second = createMailCaptureClient({ postMessage: packet => packets.push(packet) });
  const results = [first.capture({ raw: Uint8Array.of(1) }), second.capture({ raw: Uint8Array.of(2) })];
  assert.notEqual(packets[0].id, packets[1].id);
  assert.notEqual(packets[0].captureId, packets[1].captureId);
  const ownerPackets = [];
  const nested = createMailCaptureClient({ postMessage: packet => ownerPackets.push(packet) });
  assert.equal(replyToMailCapture(packets[0], { capture: nested.capture, postMessage: first.receive }), true);
  assert.equal(ownerPackets[0].captureId, packets[0].captureId);
  assert.notEqual(ownerPackets[0].id, packets[0].id);
  assert.equal(replyToMailCapture({ type: 'other' }, {}), false);
  replyToMailCapture(ownerPackets[0], { capture: () => true, postMessage: nested.receive });
  replyToMailCapture(packets[1], { capture: () => true, postMessage: second.receive });
  assert.deepEqual(await Promise.all(results), [true, true]);
  first.close(); second.close(); nested.close();
});

test('reply helper rejects malformed metadata and failed captures, without unhandled reply errors', async () => {
  for (const capture of [() => false, () => { throw new Error('storage full'); }, () => Promise.reject(new Error('storage failed'))]) {
    const result = await new Promise(resolve => replyToMailCapture({ type: 'mail-call', id: 'id', captureId: 'capture', payload: {} },
      { capture, postMessage: resolve }));
    assert.equal(typeof result.error, 'string');
    assert.equal('value' in result, false);
  }
  const malformed = await new Promise(resolve => replyToMailCapture({ type: 'mail-call', id: 'id' },
    { capture: () => assert.fail('Malformed packet must not reach storage'), postMessage: resolve }));
  assert.match(malformed.error, /Invalid mail capture packet/);
  assert.doesNotThrow(() => replyToMailCapture({ type: 'mail-call', id: 'id', captureId: 'capture' },
    { capture: () => true, postMessage: () => { throw new Error('closed recipient'); } }));
  await Promise.resolve();
});

test('capability check and INI require the native local sendmail contract', () => {
  assert.doesNotThrow(() => requireMailCapture({ mailCaptureVersion: 1 }));
  for (const runtime of [undefined, {}, { mailCaptureVersion: '1' }, { mailCaptureVersion: 2 }]) {
    assert.throws(() => requireMailCapture(runtime), /local mail capture version 1/);
  }
  assert.equal(SENDMAIL_INI, 'sendmail_path="/usr/sbin/sendmail -t -i"');
});
