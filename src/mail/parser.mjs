import PostalMime from 'postal-mime';

/** Decode a preview with PostalMime's bounded defaults; raw MIME stays in the mailbox. */
export async function parseMail(raw) {
  if (!(raw instanceof Uint8Array)) throw new TypeError('Mail parser requires raw bytes.');
  const parsed = await PostalMime.parse(raw, { forceRfc822Attachments: true });
  return {
    subject: parsed.subject ?? null, from: parsed.from ?? null,
    to: parsed.to ?? [], cc: parsed.cc ?? [], bcc: parsed.bcc ?? [],
    date: parsed.date ?? null, text: parsed.text ?? null, html: parsed.html ?? null,
    headers: parsed.headers.map(({ key, value }) => ({ key, value })),
    attachments: parsed.attachments.map(attachment => ({
      filename: attachment.filename ?? null, mimeType: attachment.mimeType,
      disposition: attachment.disposition ?? null, contentId: attachment.contentId ?? null,
      related: attachment.related === true, size: attachment.content.byteLength,
    })),
  };
}
