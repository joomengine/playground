import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSessionMailbox } from '../src/mail/mailbox.mjs';
import { readCapturedBrowserMail } from './mail-browser-contract.mjs';

const capture = {
  version: 1, captureId: 'browser-acceptance', raw: new TextEncoder().encode('Subject: Delayed\r\n\r\nbody'),
  command: '/usr/sbin/sendmail -t -i', args: ['-t', '-i'], envelopeSender: null,
  envelopeRecipients: ['recipient@example.invalid'], readRecipientsFromHeaders: true,
};
function pageFor(mail, onEvaluate = () => {}) {
  return {
    waitForFunction() { throw new Error('Async readiness must be polled with awaited page.evaluate.'); },
    async evaluate(callback) {
      const result = await runInNewContext(`(${callback.toString()})()`, { window: { playground: { mail } } });
      onEvaluate();
      return structuredClone(result);
    },
  };
}

test('browser mail acceptance waits through repeated pending snapshots until the real parser completes', async () => {
  const parsed = Promise.withResolvers(), polled = Promise.withResolvers();
  const owner = createSessionMailbox({ parseMail: () => parsed.promise });
  let evaluations = 0, settled = false;
  try {
    assert.equal(owner.activateGeneration('worker')(capture), true);
    const reading = readCapturedBrowserMail(pageFor(owner.mail, () => {
      if (++evaluations === 3) polled.resolve();
    }), 1, { timeoutMs: 1_000, pollMs: 1 });
    reading.then(() => { settled = true; }, () => { settled = true; });
    await polled.promise;
    assert.equal(settled, false, 'Accepted mail with unfinished MIME parsing must not satisfy the browser assertion.');
    parsed.resolve({ subject: 'Delayed', text: 'body', attachments: [] });
    const [entry] = await reading;
    assert.equal(entry.parseStatus, 'ready');
    assert.equal(entry.subject, 'Delayed');
    assert.deepEqual(entry.raw, [...capture.raw]);
  } finally { owner.close(); }
});

test('browser mail acceptance reports the actual parser failure instead of a null assertion message', async () => {
  const owner = createSessionMailbox({ parseMail: () => { throw new Error('MIME fixture decoder failed'); } });
  try {
    owner.activateGeneration('worker')(capture);
    await assert.rejects(readCapturedBrowserMail(pageFor(owner.mail), 1, { timeoutMs: 1_000, pollMs: 1 }), /failed MIME parsing: MIME fixture decoder failed/);
  } finally { owner.close(); }
});

test('browser mail acceptance times out with pending count and parse-state evidence', async () => {
  const owner = createSessionMailbox({ parseMail: () => new Promise(() => {}) });
  try {
    owner.activateGeneration('worker')(capture);
    await assert.rejects(readCapturedBrowserMail(pageFor(owner.mail), 1, { timeoutMs: 20, pollMs: 1 }), error => {
      assert.match(error.message, /Timed out waiting for 1 ready captured messages/);
      assert.match(error.message, /"count":1/);
      assert.match(error.message, /"parseStatus":"pending"/);
      return true;
    });
  } finally { owner.close(); }
});
