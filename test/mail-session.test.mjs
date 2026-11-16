import test from 'node:test';
import assert from 'node:assert/strict';
import { PhpSession } from '../src/playground.mjs';
import { createSessionMailbox } from '../src/mail/mailbox.mjs';

const drain = () => new Promise(resolve => setImmediate(resolve));
const captureEvent = () => ({
  version: 1, raw: new Uint8Array([65, 0, 255, 13, 10]),
  command: '/usr/sbin/sendmail -t -i', args: ['-t', '-i'],
  envelopeSender: null, envelopeRecipients: [], readRecipientsFromHeaders: true,
});

function fixture(t, capture) {
  const previous = globalThis.Worker;
  globalThis.Worker = class {
    messages = [];
    addEventListener() {}
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  };
  const session = new PhpSession(null, undefined, undefined, undefined, capture);
  const pending = [];
  t.after(async () => {
    session.fail(new Error('Test complete'));
    await Promise.allSettled(pending);
    if (previous === undefined) delete globalThis.Worker;
    else globalThis.Worker = previous;
  });
  return { session, track(promise) { promise.catch(() => {}); pending.push(promise); return promise; } };
}

test('mail acceptance stores raw bytes and answers while PHP and its later save hold the queue', async t => {
  const mailbox = createSessionMailbox({ parseMail: async () => { throw new Error('Preview unavailable'); } });
  t.after(() => mailbox.close());
  const sink = mailbox.activateGeneration('worker-one');
  const { session, track } = fixture(t, (payload, captureId) => sink({ ...payload, captureId }));
  const request = track(session.send('request'));
  const save = track(session.flushTogether());
  await drain();
  const requestId = session.worker.messages[0].id;
  const payload = captureEvent();
  await session.receive({ type: 'mail-call', id: 'mail-request', captureId: 'capture-one', payload });
  assert.equal(mailbox.mail.state.count, 1, 'Storage completes before the ACK');
  payload.raw.fill(0);
  await drain();
  assert.deepEqual(session.worker.messages.at(-1), { type: 'mail-result', id: 'mail-request', value: true });
  assert.equal(session.worker.messages.filter(message => message.type === 'operation').length, 1);
  const [summary] = await mailbox.mail.list();
  assert.deepEqual((await mailbox.mail.get(summary.id)).raw, captureEvent().raw);
  await mailbox.mail.clear();
  await session.receive({ type: 'mail-call', id: 'mail-replay', captureId: 'capture-one', payload: captureEvent() });
  await drain();
  assert.equal(mailbox.mail.state.count, 0, 'Clearing while PHP runs does not allow a late duplicate to return');
  assert.equal(session.worker.messages.at(-1).value, true);
  await session.receive({ type: 'result', id: requestId, value: { databaseUsed: false, status: 200 } });
  await request;
  await drain();
  assert.equal(session.worker.messages.at(-1).operation, 'flush');
  await session.receive({ type: 'result', id: session.worker.messages.at(-1).id, value: null });
  await save;
});

test('mail replies await explicit owner acceptance and reject capture failures without failing PHP', async t => {
  let accept;
  const { session } = fixture(t, () => new Promise(resolve => { accept = resolve; }));
  await session.receive({ type: 'mail-call', id: 'pending', captureId: 'capture-one', payload: captureEvent() });
  assert.equal(session.worker.messages.length, 0);
  accept(true);
  await drain();
  assert.deepEqual(session.worker.messages.at(-1), { type: 'mail-result', id: 'pending', value: true });
  for (const capture of [() => false, () => { throw new Error('Inbox allocation failed'); }, undefined]) {
    session.captureMail = capture;
    await session.receive({ type: 'mail-call', id: 'rejected', captureId: 'capture-two', payload: captureEvent() });
    await drain();
    const reply = session.worker.messages.at(-1);
    assert.equal(reply.type, 'mail-result');
    assert.equal(reply.id, 'rejected');
    assert.equal(typeof reply.error, 'string');
    assert.equal(Object.hasOwn(reply, 'value'), false);
    assert.equal(session.failure, null);
  }
});

test('replaced and failed workers cannot insert mail or clear the continuing owner inbox', async t => {
  const mailbox = createSessionMailbox({ parseMail: async () => ({ subject: 'Captured' }) });
  t.after(() => mailbox.close());
  const sink = mailbox.activateGeneration('worker-one');
  const { session } = fixture(t, (payload, captureId) => sink({ ...payload, captureId }));
  await session.receive({ type: 'mail-call', id: 'first', captureId: 'capture-one', payload: captureEvent() });
  const nextSink = mailbox.activateGeneration('worker-two');
  await session.receive({ type: 'mail-call', id: 'retired', captureId: 'capture-two', payload: captureEvent() });
  await drain();
  assert.match(session.worker.messages.at(-1).error, /replaced/);
  assert.equal(mailbox.mail.state.count, 1);
  assert.equal(mailbox.mail.state.error, null);
  assert.equal(nextSink({ ...captureEvent(), captureId: 'capture-three' }), true);
  await session.fail(new Error('PHP worker failed'));
  await session.receive({ type: 'mail-call', id: 'failed', captureId: 'capture-four', payload: captureEvent() });
  await drain();
  assert.match(session.worker.messages.at(-1).error, /PHP worker failed/);
  assert.equal(mailbox.mail.state.count, 2);
  assert.equal(mailbox.mail.state.closed, false);
});
