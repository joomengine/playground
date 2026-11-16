const defaultParser = async raw => (await import('../../assets/mail/parser.mjs')).parseMail(raw);
const messageOf = error => error instanceof Error ? error.message : String(error);

function validateCapture(event) {
  if (!event || event.version !== 1 || !(event.raw instanceof Uint8Array)
    || typeof event.captureId !== 'string' || !event.captureId
    || typeof event.command !== 'string' || !event.command
    || !Array.isArray(event.args) || !event.args.every(value => typeof value === 'string')
    || !(event.envelopeSender === null || typeof event.envelopeSender === 'string')
    || !Array.isArray(event.envelopeRecipients) || !event.envelopeRecipients.every(value => typeof value === 'string')
    || typeof event.readRecipientsFromHeaders !== 'boolean') {
    throw new TypeError('Invalid version 1 mail capture event.');
  }
}

function summary(entry) {
  return {
    id: entry.id, receivedAt: entry.receivedAt, size: entry.raw.byteLength,
    subject: entry.parsed?.subject ?? null, from: entry.parsed?.from ?? null,
    to: entry.parsed?.to ?? [], cc: entry.parsed?.cc ?? [],
    parseStatus: entry.parseStatus, parseError: entry.parseError,
    attachmentCount: entry.parsed?.attachments?.length ?? 0,
  };
}

/** Session memory only: raw bytes are retained before acceptance, never persisted. */
export function createSessionMailbox({ parseMail = defaultParser } = {}) {
  if (typeof parseMail !== 'function') throw new TypeError('Mail parser must be a function.');
  const entries = new Map(), listeners = new Set();
  let generation = null, closed = false, error = null, version = 0;
  const state = () => Object.freeze({ count: entries.size, closed, error, version });
  const changed = () => {
    version++;
    const snapshot = state();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch { /* Views cannot reject an accepted message. */ }
    }
  };
  const clearEntries = () => {
    for (const entry of entries.values()) clearTimeout(entry.parseTimer);
    entries.clear();
  };
  const mail = Object.freeze({
    get state() { return state(); },
    async list() { return structuredClone([...entries.values()].reverse().map(summary)); },
    async get(id) {
      const entry = entries.get(id);
      if (!entry) return null;
      return structuredClone({ ...summary(entry), raw: entry.raw, ...entry.transport, parsed: entry.parsed });
    },
    async clear() {
      if (!closed) { clearEntries(); error = null; changed(); }
      return state();
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Mail listener must be a function.');
      if (!closed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  function activateGeneration(token) {
    if (closed) throw new Error('The mail inbox is closed.');
    generation?.accepted.clear();
    const active = { token, accepted: new Set() };
    generation = active;
    return event => {
      // A delayed packet from an old worker must not alter the current site's error.
      if (closed) throw new Error('The mail inbox is closed.');
      if (generation !== active) throw new Error('The mail capture worker was replaced.');
      try {
        validateCapture(event);
        if (active.accepted.has(event.captureId)) return true;
        const entry = {
          id: crypto.randomUUID(), receivedAt: new Date().toISOString(), raw: new Uint8Array(event.raw),
          transport: { command: event.command, args: [...event.args], envelopeSender: event.envelopeSender,
            envelopeRecipients: [...event.envelopeRecipients], readRecipientsFromHeaders: event.readRecipientsFromHeaders },
          parsed: null, parseStatus: 'pending', parseError: null,
        };
        active.accepted.add(event.captureId);
        try { entries.set(entry.id, entry); }
        catch (storageError) { active.accepted.delete(event.captureId); throw storageError; }
        changed();
        // A task boundary lets the owner return its ACK before MIME decoding starts.
        entry.parseTimer = setTimeout(async () => {
          if (entries.get(entry.id) !== entry) return;
          try {
            const parsed = structuredClone(await parseMail(entry.raw.slice()));
            if (entries.get(entry.id) !== entry) return;
            entry.parsed = parsed;
            entry.parseStatus = 'ready';
          } catch (parseError) {
            if (entries.get(entry.id) !== entry) return;
            entry.parseStatus = 'error';
            entry.parseError = messageOf(parseError);
          }
          changed();
        }, 0);
        return true;
      } catch (captureError) {
        error = messageOf(captureError);
        changed();
        throw captureError;
      }
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    generation?.accepted.clear();
    generation = null;
    clearEntries();
    error = null;
    changed();
    listeners.clear();
  }
  return { mail, activateGeneration, close };
}
