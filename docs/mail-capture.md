# Local mail capture

**Mail** sits immediately after **DB** in the top menu. Its badge shows the total
number of messages in the running site's inbox, including messages whose preview
is still parsing or could not be parsed. The badge is hidden at zero. Opening a
message does not mark it read or reduce the count.

The inbox lists newest messages first. Select a message to inspect its subject,
addresses, receive time and available envelope information, then choose **Text**,
**HTML** or **Raw**. **Download .eml** downloads the original captured bytes,
including binary MIME parts. The raw text view is a readable decoding of those
bytes; use the download when exact bytes matter. Attachments are listed by name,
falling back to media type. The API exposes both, plus size, disposition and content ID.
There is no separate attachment download or CID image reconstruction.

HTML is an isolated preview with a restricted element set, an empty iframe
sandbox and a restrictive content security policy. Scripts, forms, navigation,
remote images, external styles and other network loads are blocked. Supported
inline raster data images can render. The preview can therefore differ from a
mail client's rendering. Subjects, addresses and raw source are displayed as
text, never inserted as trusted HTML.

## What is captured

The PHP runtime supplies a virtual `/usr/sbin/sendmail` through its native
`popen`/`pclose` path. Playground sets
`sendmail_path="/usr/sbin/sendmail -t -i"` in runtime-only PHP configuration and
requires `mailCaptureVersion === 1` after the binary initializes. This captures
ordinary PHP `mail()`, PHPMailer in Sendmail mode, and Joomla/JCB using their
default PHP mail transport. The same owner inbox receives HTTP requests,
`runPhp`, console execution, nested self-requests and debugger execution.

Joomla's default mail configuration already uses the supported transport; no
mail-capture patch is written into `configuration.php` or installed extensions.
Imported or explicitly configured SMTP settings are preserved. SMTP and HTTP
provider APIs bypass the Sendmail path and do not appear in this inbox. Whether
those providers work depends on their transport and the browser environment.
There is no SMTP server or automatic delivery from the local inbox.

The owner copies a complete raw message into memory before acknowledging it to
PHP. A successful `mail()` result means local capture was accepted, not that an
external recipient received a message. MIME preview parsing happens afterward;
a parsing error retains the message, count and original `.eml` bytes.

## Inbox lifetime

Each live site owner has one inbox. Main requests, nested workers, the debugger
and companion windows all use that owner. Companion state notifications contain
only `{ count, closed, error, version }`; opening a message requests its content
explicitly. Closing a companion window or the Mail dialog only detaches that
view. Clearing the inbox from any view clears the same shared owner inbox.

| Action | Inbox result |
| --- | --- |
| Open/close Mail, Code, DB or a companion view | Retained |
| Recover PHP after an application error, change PHP settings or switch PHP version within the same site | Retained |
| Export files, SQL or a complete site; create a checkpoint | Retained in the running owner; excluded from the exported data |
| Clear | Messages and current capture error removed; owner remains usable |
| Stop/close or reset the site; reload or close the owner page | Cleared with the owner |
| Reopen a saved site, restore an export/checkpoint or create a saved copy of a temporary site | New owner starts with an empty inbox |

Mail is never stored in IndexedDB, the PHP filesystem, MariaDB, saved site data,
checkpoints or portable exports. Saving an already persistent site leaves the
current owner intact. Saving a temporary site creates a replacement saved owner,
so that replacement starts with an empty inbox. If saving fails before the
original owner can close, its running inbox remains available.

## JavaScript API

Both the browser `createPlayground()` handle and the Node `createNodeRuntime()`
handle expose `runtime.mail`. Companion handles proxy the same API. Mail methods
do not enter the PHP operation queue, so inspection remains available while PHP
is running or paused at a breakpoint.

| Member | Contract |
| --- | --- |
| `state` | Read-only snapshot `{ count, closed, error, version }`; `version` increases when inbox state changes |
| `await list()` | Newest-first cloned summaries, without raw bytes or bodies |
| `await get(id)` | A cloned complete entry, or `null` if it no longer exists |
| `await clear()` | Clear all entries and current capture error; return updated state |
| `subscribe(listener)` | Observe subsequent state changes; return an unsubscribe function |

Read `state` to obtain the initial snapshot; subscribing does not immediately
invoke the listener. A summary contains `id`, `receivedAt`, `size`, `subject`,
`from`, `to`, `cc`, `parseStatus`, `parseError` and `attachmentCount`.
`parseStatus` is `pending`, `ready` or `error`. The count includes all three.

`get(id)` additionally returns `raw` as a copied `Uint8Array`, `command`, `args`,
`envelopeSender`, `envelopeRecipients`, `readRecipientsFromHeaders` and `parsed`.
Envelope recipients are command arguments, so they can be empty when Sendmail
reads recipients from the headers. Parsed addresses describe those headers;
they are not proof of external delivery. `parsed` is initially `null`; on
success it contains decoded `subject`, `from`, `to`, `cc`, `bcc`, `date`, `text`,
`html`, `headers` and attachment metadata. Mutating returned data does not modify
the stored message.

For an existing runtime handle:

```js
const unsubscribe = runtime.mail.subscribe(state => {
  console.log(`Captured messages: ${state.count}`);
  if (state.error) console.error(state.error);
});

console.log(runtime.mail.state);
const messages = await runtime.mail.list();
if (messages.length) {
  const message = await runtime.mail.get(messages[0].id);
  if (message) console.log(message.parseStatus, message.raw);
}

unsubscribe();
```

## Failures and investigation

Missing capability version 1 is a startup error. Unsupported native Sendmail
commands, a missing or rejecting capture callback, callback exceptions, worker
closure and acknowledgement timeout fail capture rather than reporting a
successful send. The worker acknowledgement deadline is 30 seconds. Capture
acknowledgements use a separate message channel so a suspended PHP request cannot
block the response it needs to finish.

`state.error` exposes owner-side capture errors. Per-message `parseError` exposes
preview failures independently; raw inspection and download remain available.
When PHP reports a capture failure, inspect its return value or exception and
the runtime diagnostics as well as the inbox. A message can have reached the
owner before its acknowledgement was lost. There is no automatic resend after
an uncertain result. Forwarded capture identities prevent duplicate worker
packets from adding the same message twice, including after Clear; a deliberate
new application send is a new message. Retired worker packets cannot append mail
to a replacement worker's session.

The parser is PostalMime **4.2.1**, bundled as a browser ESM module with its
MIT-0 license. Its parsing limits protect preview processing; parser rejection
does not truncate or discard accepted raw mail. The session inbox has no
automatic eviction policy, so Clear releases retained messages when they are no
longer needed.

## Runtime validation and release order

Production builds resolve published stable releases from
`joomengine/php-wasm-int64`. `npm run prepare:php` follows that policy and never
implicitly selects an unpublished build. The selected runtime must advertise
the mail capability in its verified manifest and initialized runtime.

While this integration is under review, `.github/php-runtime-candidate.json`
pins the exact PHP commit `ed6d85e4b0a8c040422d2f2ce2f4e3f41b3debc9`.
Pull-request CI builds the supported PHP lines from that clean source checkout,
verifies the source inputs, build fingerprint, archive checksum, inventory, ABI
and mail capability, and imports the result explicitly. Candidate caches require
the exact build fingerprint. The generated selection and asset manifest mark it
as `kind: "candidate"` with its source commit; this is validation evidence, not a
published PHP release.

The explicit import entry point is
`node scripts/php-runtime.mjs import-candidate <archive-directory> <source-checkout>`.
It requires complete matching archives and the exact clean pinned checkout;
ordinary stable-release build instructions remain unchanged. GitHub Pages
publication rejects candidate artifacts.

The release sequence is: validate and publish the compatible PHP release first,
remove the temporary Playground candidate pin, then rebuild and run Playground's
full validation against the published stable release. Only that validated release
artifact is eligible for Playground publication. A green candidate PR does not
publish PHP or deploy Playground by itself.

## Validation

Run source and unit checks with Node 26.12.1 or later:

```bash
npm run check
npm test
```

The mail model, parser and channel tests cover raw-byte preservation, copied
results, clear/close, stale generations, duplicate packets, failed parsing,
rejected callbacks and bounded missing acknowledgements. Self-request and
watchdog tests cover forwarding and reads outside the busy PHP queue. Companion
tests check metadata-only notifications and explicit content reads.

After building the matching native adapters and static distribution, run the
native integration suite and focused browser checks:

```bash
npm run test:provisioning
node --test test/mail-ui.browser.mjs test/self-request.browser.mjs
npm run test:browser
```

`test/mail.integration.mjs` exercises real PHP 8.3, 8.4 and 8.5 sends, HTTP and
nested requests, recovery, binary MIME and concurrent inbox inspection.
Debugger integration checks capture before a breakpoint and no replay after
resume. Joomla/JCB browser acceptance exercises default mail and PHPMailer
Sendmail, counts, companions and site lifecycle. Provisioning checks ensure
captured mail stays out of exports and imported SMTP settings survive unchanged.
The UI suite checks `.eml` byte equality, parser failure, selection stability,
responsive layout and blocked active HTML/network content. These commands require
the staged distribution and Playwright browser engines described in the
[main validation guide](../README.md#validation).
