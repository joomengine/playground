import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';

async function deadline(promise, label, timeoutMs = 20_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function parsedEntries(mail, count) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const summaries = await mail.list();
    assert.equal(summaries.length, count, 'Capture acknowledgement must retain the message before PHP resumes.');
    assert.ok(summaries.every(summary => !('raw' in summary) && !('parsed' in summary)), 'Lists must not copy private MIME bodies.');
    if (summaries.every(summary => summary.parseStatus !== 'pending')) {
      const entries = await Promise.all(summaries.map(summary => mail.get(summary.id)));
      for (const entry of entries) assert.equal(entry.parseStatus, 'ready', entry.parseError);
      return entries;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Captured mail previews did not settle.');
}

const send = (subject, ending = '') => `<?php
  $sent = mail('recipient@example.invalid', ${JSON.stringify(subject)}, 'Local mail body',
    'From: sender@example.invalid', '-fbounce@example.invalid');
  if (!$sent) throw new RuntimeException('Local capture was rejected');
  echo 'accepted'; ${ending}`;

for (const phpVersion of ['8.3', '8.4', '8.5']) {
  test(`PHP ${phpVersion}: owner inbox captures native, HTTP and nested mail, survives recovery and stays readable during PHP`, { timeout: 240_000 }, async t => {
    const runtime = await createNodeRuntime({ directory: process.env.PLAYGROUND_DIST, phpVersion });
    t.after(() => runtime.close());
    assert.equal(runtime.runtimeInfo.mailCaptureVersion, 1);
    assert.equal(runtime.mail.state.count, 0);
    const observed = [];
    const unsubscribe = runtime.mail.subscribe(state => observed.push(state));
    t.after(unsubscribe);
    const direct = await runtime.runPhp(send('Direct PHP capture'));
    assert.equal(direct.status, 200, direct.text);
    assert.equal(direct.text, 'accepted');
    let entries = await parsedEntries(runtime.mail, 1);
    assert.equal(entries[0].subject, 'Direct PHP capture');
    assert.equal(entries[0].envelopeSender, 'bounce@example.invalid');
    assert.match(entries[0].parsed.text, /Local mail body/);
    assert.ok(entries[0].parsed.to.some(address => address.address === 'recipient@example.invalid'));

    const raw = Buffer.concat([Buffer.from([
      'From: MIME author <author@example.invalid>', 'To: recipient@example.invalid',
      'Bcc: hidden@example.invalid', 'Subject: =?UTF-8?B?R3LDvMOfZSDml6XmnKzoqp4=?=',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="mail-contract"', '',
      '--mail-contract', 'Content-Type: text/plain; charset=UTF-8', '', 'Byte-preserved MIME body',
      '--mail-contract', 'Content-Type: application/octet-stream; name="fixture.bin"',
      'Content-Disposition: attachment; filename="fixture.bin"', 'Content-Transfer-Encoding: binary', '', '',
    ].join('\r\n')), Buffer.from([0, 255, 128, 13, 10]), Buffer.from('\r\n--mail-contract--\r\n')]);
    await runtime.fs.writeFile('/persist/www/mail-http.php', `<?php
      $pipe = popen('/usr/sbin/sendmail -oi -fhttp@example.invalid -t', 'w');
      $raw = base64_decode('${raw.toString('base64')}');
      if (!is_resource($pipe) || fwrite($pipe, $raw) !== strlen($raw)) throw new RuntimeException('Incomplete MIME write');
      header('Content-Type: application/json'); echo json_encode(['accepted' => pclose($pipe) === 0]);`);
    const response = await runtime.request('mail-http.php');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true });
    entries = await parsedEntries(runtime.mail, 2);
    const mime = entries.find(entry => entry.envelopeSender === 'http@example.invalid');
    assert.ok(mime);
    assert.equal(mime.subject, 'Grüße 日本語');
    assert.deepEqual(Buffer.from(mime.raw), raw, 'The HTTP capture must retain NUL and non-UTF-8 attachment bytes.');
    assert.equal(mime.parsed.attachments.length, 1);
    assert.equal(mime.parsed.attachments[0].filename, 'fixture.bin');
    assert.equal(mime.parsed.attachments[0].size, 5);
    assert.ok(mime.parsed.bcc.some(address => address.address === 'hidden@example.invalid'));
    mime.raw.fill(0);
    assert.deepEqual(Buffer.from((await runtime.mail.get(mime.id)).raw), raw, 'An inbox consumer must not mutate retained bytes.');

    await runtime.fs.writeFile('/persist/www/mail-child.php', send('Nested PHP capture'));
    const nested = await runtime.runPhp(`<?php
      $curl = curl_init(${JSON.stringify(new URL('mail-child.php', runtime.baseUrl).href)});
      curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30]);
      $body = curl_exec($curl); $error = curl_error($curl); $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
      if ($body !== 'accepted' || $status !== 200) throw new RuntimeException('Nested mail failed: ' . $error);
      if (!mail('parent@example.invalid', 'Parent PHP capture', 'Parent resumed', 'From: sender@example.invalid')) throw new RuntimeException('Parent capture failed');
      echo 'parent accepted';`);
    assert.equal(nested.status, 200, nested.text);
    assert.equal(nested.text, 'parent accepted');
    entries = await parsedEntries(runtime.mail, 4);
    assert.equal(entries.filter(entry => entry.subject === 'Nested PHP capture').length, 1);
    assert.equal(entries.filter(entry => entry.subject === 'Parent PHP capture').length, 1);

    const failed = await runtime.runPhp(send('Captured before PHP failure', "throw new RuntimeException('Mail recovery fixture');"));
    assert.equal(failed.status, 500, failed.text);
    assert.equal(runtime.mail.state.count, 5, 'Recovery must keep accepted mail without replaying it.');
    const recovered = await runtime.runPhp(send('Captured after PHP recovery'));
    assert.equal(recovered.status, 200, recovered.text);
    entries = await parsedEntries(runtime.mail, 6);
    assert.equal(entries.filter(entry => entry.subject === 'Captured before PHP failure').length, 1);
    assert.equal(entries.filter(entry => entry.subject === 'Captured after PHP recovery').length, 1);
    const unfinished = await runtime.runPhp(`<?php
      $GLOBALS['unfinishedMail'] = popen('/usr/sbin/sendmail -t -i', 'w');
      fwrite($GLOBALS['unfinishedMail'], "Subject: unfinished\\r\\n\\r\\npartial"); echo 'unfinished';`);
    assert.equal(unfinished.status, 200, unfinished.text);
    assert.equal(runtime.mail.state.count, 6, 'Request cleanup must not accept an unclosed mail pipe.');

    let release, started;
    const requested = new Promise(resolve => { started = resolve; });
    const server = createServer((_request, response) => { release = () => response.end('released'); started(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const pending = runtime.runPhp(send('Visible while PHP waits', `
      $curl = curl_init('http://127.0.0.1:${server.address().port}/wait');
      curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30]);
      if (curl_exec($curl) !== 'released') throw new RuntimeException('Wait fixture did not resume');`));
    try {
      await deadline(Promise.race([requested, pending.then(() => {
        throw new Error('PHP completed before reaching the held HTTP request.');
      })]), 'PHP must reach HTTP after mail acknowledgement');
      const live = await deadline(runtime.mail.list(), 'Mail inspection must not wait for the PHP operation queue', 3_000);
      assert.equal(live.length, 7);
      const current = await deadline(runtime.mail.get(live[0].id), 'Raw mail inspection during PHP', 3_000);
      assert.match(new TextDecoder().decode(current.raw), /Visible while PHP waits/);
    } finally { release?.(); }
    assert.equal((await pending).status, 200);
    assert.ok(observed.some(state => state.count === 7), 'Owner events must publish mail count changes.');
    const oldId = (await runtime.mail.list())[0].id;
    const previousVersion = runtime.mail.state.version;
    await runtime.mail.clear();
    assert.equal(runtime.mail.state.count, 0);
    assert.ok(runtime.mail.state.version > previousVersion);
    assert.deepEqual(await runtime.mail.list(), []);
    assert.equal(await runtime.mail.get(oldId), null);
    await runtime.close();
    assert.equal(runtime.mail.state.closed, true);
  });
}
