import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionMailbox } from '../src/mail/mailbox.mjs';

const capture = (captureId = 'message-1', raw = new TextEncoder().encode('Subject: Test\r\n\r\nbody')) => ({
  captureId, version: 1, raw, command: '/usr/sbin/sendmail -t -i', args: ['-t', '-i'],
  envelopeSender: null, envelopeRecipients: [], readRecipientsFromHeaders: true,
});
const parsed = subject => ({ subject, from: { name: 'Sender', address: 'sender@example.invalid' },
  to: [{ name: '', address: 'to@example.invalid' }], cc: [], bcc: [], date: null,
  text: 'body', html: null, headers: [], attachments: [] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function nextChange(mail) {
  return new Promise(resolve => { const stop = mail.subscribe(state => { stop(); resolve(state); }); });
}

test('capture owns bytes and metadata before ACK; parsing and readers cannot mutate retained mail', async () => {
  const started = deferred(), finish = deferred();
  let parserRaw;
  const owner = createSessionMailbox({ parseMail: raw => { parserRaw = raw; started.resolve(); return finish.promise; } });
  const sink = owner.activateGeneration('worker-1');
  const native = capture('one', Buffer.from([0, 255, 1, 2]));
  const snapshots = [];
  owner.mail.subscribe(state => snapshots.push(state));
  owner.mail.subscribe(() => { throw new Error('Broken view'); });
  assert.equal(sink(native), true);
  assert.deepEqual(owner.mail.state, { count: 1, closed: false, error: null, version: 1 });
  assert.equal(Object.isFrozen(snapshots[0]), true);
  native.raw.fill(9); native.args.push('mutated'); native.envelopeRecipients.push('wrong');
  const [pending] = await owner.mail.list();
  assert.equal(pending.parseStatus, 'pending');
  assert.equal(pending.subject, null);
  assert.equal('raw' in pending, false);
  assert.equal('parsed' in pending, false);
  assert.equal('command' in pending, false);
  assert.deepEqual((await owner.mail.get(pending.id)).raw, Uint8Array.of(0, 255, 1, 2));
  await started.promise;
  parserRaw.fill(7);
  const completion = nextChange(owner.mail);
  const preview = parsed('Decoded');
  finish.resolve(preview);
  await completion;
  preview.to[0].address = 'changed';
  const entry = await owner.mail.get(pending.id);
  assert.deepEqual(entry.raw, Uint8Array.of(0, 255, 1, 2));
  assert.deepEqual(entry.args, ['-t', '-i']);
  assert.deepEqual(entry.envelopeRecipients, []);
  assert.equal(entry.parsed.to[0].address, 'to@example.invalid');
  entry.raw.fill(4); entry.parsed.from.address = 'changed';
  assert.deepEqual((await owner.mail.get(pending.id)).raw, Uint8Array.of(0, 255, 1, 2));
  const list = await owner.mail.list();
  list[0].from.address = 'changed';
  assert.equal((await owner.mail.list())[0].from.address, 'sender@example.invalid');
  owner.close();
});

test('parse rejection retains exact raw and count, without undoing acceptance', async () => {
  const owner = createSessionMailbox({ parseMail: () => { throw new Error('Malformed MIME'); } });
  const native = capture();
  assert.equal(owner.activateGeneration('worker')(native), true);
  const completion = nextChange(owner.mail);
  await completion;
  const [summary] = await owner.mail.list();
  assert.equal(summary.parseStatus, 'error');
  assert.equal(summary.parseError, 'Malformed MIME');
  assert.equal(owner.mail.state.count, 1);
  assert.equal(owner.mail.state.error, null);
  assert.deepEqual((await owner.mail.get(summary.id)).raw, native.raw);
  owner.close();
});

test('clear deduplicates late accepted packets and ignores pending parse completion', async () => {
  const started = deferred(), finish = deferred();
  const owner = createSessionMailbox({ parseMail: () => { started.resolve(); return finish.promise; } });
  const sink = owner.activateGeneration('worker');
  sink(capture());
  const [{ id }] = await owner.mail.list();
  await started.promise;
  const cleared = await owner.mail.clear();
  assert.equal(sink(capture()), true);
  assert.deepEqual(owner.mail.state, cleared);
  finish.resolve(parsed('Late'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(owner.mail.state, cleared);
  assert.equal(await owner.mail.get(id), null);
  assert.deepEqual(await owner.mail.list(), []);
  owner.close();
});

test('retired worker rejection cannot poison active state; new worker retains earlier messages', async () => {
  const owner = createSessionMailbox({ parseMail: () => parsed('Subject') });
  const old = owner.activateGeneration('old');
  old(capture('same'));
  const current = owner.activateGeneration('current');
  const before = owner.mail.state;
  assert.throws(() => old(capture('new')), /replaced/);
  assert.deepEqual(owner.mail.state, before);
  assert.equal(current(capture('same')), true);
  assert.equal(owner.mail.state.count, 2);
  const entries = await owner.mail.list();
  assert.notEqual(entries[0].id, entries[1].id);
  owner.close();
});

test('malformed events reject visibly without replacing retained messages', async () => {
  const owner = createSessionMailbox({ parseMail: () => parsed('Subject') });
  const sink = owner.activateGeneration('worker');
  sink(capture('valid'));
  for (const invalid of [null, { ...capture(), version: 2 }, { ...capture(), raw: 'text' },
    { ...capture(), args: ['-t', 3] }, { ...capture(), envelopeSender: undefined },
    { ...capture(), envelopeRecipients: [null] }, { ...capture(), readRecipientsFromHeaders: 1 },
    { ...capture(), captureId: '' }]) {
    assert.throws(() => sink(invalid), /Invalid version 1/);
    assert.equal(owner.mail.state.count, 1);
    assert.match(owner.mail.state.error, /Invalid version 1/);
  }
  assert.equal((await owner.mail.clear()).error, null);
  owner.close();
});

test('close clears content, rejects every sink and ignores late parse failure', async () => {
  const started = deferred(), finish = deferred();
  const owner = createSessionMailbox({ parseMail: () => { started.resolve(); return finish.promise; } });
  const sink = owner.activateGeneration('worker');
  sink(capture());
  await started.promise;
  const last = nextChange(owner.mail);
  owner.close();
  const final = await last;
  assert.equal(final.closed, true);
  assert.equal(final.count, 0);
  assert.throws(() => sink(capture()), /closed/);
  assert.throws(() => owner.activateGeneration('next'), /closed/);
  finish.reject(new Error('Late parser rejection'));
  await new Promise(resolve => setTimeout(resolve, 0));
  owner.close();
  assert.deepEqual(owner.mail.state, final);
  assert.deepEqual(await owner.mail.clear(), final);
});
