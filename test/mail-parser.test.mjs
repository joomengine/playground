import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parseMail } from '../src/mail/parser.mjs';
import { createSessionMailbox } from '../src/mail/mailbox.mjs';

const encode = text => new TextEncoder().encode(text.replaceAll('\n', '\r\n'));
const multipart = encode(`From: =?UTF-8?Q?Jos=C3=A9?= <sender@example.invalid>
To: Team: first@example.invalid, second@example.invalid;
Cc: Copy <copy@example.invalid>
Bcc: hidden@example.invalid
Subject: =?UTF-8?B?SGVsbG8g8J+MjQ==?=
Date: Fri, 01 Jan 1999 01:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="outer"

--outer
Content-Type: multipart/alternative; boundary="inner"

--inner
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Ol=E1 plain
--inner
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

PHA+SGVsbG8g8J+MjTwvcD4=
--inner--
--outer
Content-Type: application/octet-stream
Content-Disposition: attachment; filename*=utf-8''caf%C3%A9.bin
Content-Transfer-Encoding: base64

AP8BAg==
--outer--
`);

test('MIME preview decodes charsets, encoded headers, grouped addresses and attachment metadata', async () => {
  const original = multipart.slice();
  const mail = await parseMail(multipart);
  assert.equal(mail.subject, 'Hello 🌍');
  assert.deepEqual(mail.from, { name: 'José', address: 'sender@example.invalid' });
  assert.equal(mail.to[0].name, 'Team');
  assert.equal(mail.to[0].group.length, 2);
  assert.equal(mail.cc[0].address, 'copy@example.invalid');
  assert.equal(mail.bcc[0].address, 'hidden@example.invalid');
  assert.match(mail.text, /Olá plain/);
  assert.match(mail.html, /<p>Hello 🌍<\/p>/);
  assert.equal(mail.attachments.length, 1);
  assert.deepEqual(mail.attachments[0], { filename: 'café.bin', mimeType: 'application/octet-stream',
    disposition: 'attachment', contentId: null, related: false, size: 4 });
  assert.equal('content' in mail.attachments[0], false);
  assert.equal(mail.headers.find(header => header.key === 'subject').value, '=?UTF-8?B?SGVsbG8g8J+MjQ==?=');
  assert.deepEqual(multipart, original);
});

test('forwarded RFC822 messages stay attachments and cannot overwrite the outer preview', async () => {
  const mail = await parseMail(encode(`Subject: Outer
Content-Type: multipart/mixed; boundary="parts"

--parts
Content-Type: text/plain

Outer body
--parts
Content-Type: message/rfc822
Content-Disposition: inline

Subject: Hidden inner
From: inner@example.invalid

Inner body
--parts--
`));
  assert.equal(mail.subject, 'Outer');
  assert.doesNotMatch(mail.text, /Inner body/);
  assert.equal(mail.from, null);
  assert.deepEqual(mail.bcc, []);
  assert.equal(mail.attachments[0].mimeType, 'message/rfc822');
  assert.ok(mail.attachments[0].size > 0);
});

test('bounded parser failure preserves the accepted complete raw message', async () => {
  const raw = encode(`X-Oversized: ${'a'.repeat(2097153)}\n\nBody`);
  const owner = createSessionMailbox({ parseMail });
  const sink = owner.activateGeneration('worker');
  sink({ captureId: 'large', version: 1, raw, command: '/usr/sbin/sendmail -t', args: ['-t'],
    envelopeSender: null, envelopeRecipients: [], readRecipientsFromHeaders: true });
  await new Promise(resolve => { const stop = owner.mail.subscribe(() => { stop(); resolve(); }); });
  const [summary] = await owner.mail.list();
  assert.equal(summary.parseStatus, 'error');
  assert.match(summary.parseError, /header/i);
  assert.equal(summary.size, raw.byteLength);
  assert.deepEqual((await owner.mail.get(summary.id)).raw, raw);
  owner.close();
});

test('staged browser ESM parser bundles dependencies and behaves identically in Node', async () => {
  const result = await build({ entryPoints: ['src/mail/parser.mjs'], bundle: true, format: 'esm',
    platform: 'browser', target: 'es2022', write: false, metafile: true, logLevel: 'silent' });
  assert.deepEqual(Object.values(result.metafile.outputs).flatMap(output => output.imports), []);
  const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  assert.deepEqual(await bundled.parseMail(multipart), await parseMail(multipart));
});
