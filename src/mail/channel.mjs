export const SENDMAIL_INI = 'sendmail_path="/usr/sbin/sendmail -t -i"';

export function requireMailCapture(runtime) {
  if (runtime?.mailCaptureVersion !== 1) {
    throw new Error('This PHP runtime does not support local mail capture version 1. Rebuild with a compatible PHP runtime.');
  }
}

const asError = value => value instanceof Error ? value : new Error(String(value));

/** A separate ACK channel: never dispatch it through the suspended PHP queue. */
export function createMailCaptureClient({ postMessage, timeoutMs = 30000 }) {
  if (typeof postMessage !== 'function') throw new TypeError('Mail postMessage must be a function.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Mail ACK timeout must be positive.');
  const pending = new Map();
  const prefix = crypto.randomUUID();
  let sequence = 0, closed = null;
  const capture = (event, captureId) => {
    if (closed) return Promise.reject(closed);
    const id = `${prefix}:${++sequence}`;
    const identity = captureId ?? id;
    if (typeof identity !== 'string' || !identity) return Promise.reject(new TypeError('Invalid mail capture ID.'));
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(pending.get(id)?.timer);
        pending.delete(id);
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('The local mail inbox did not acknowledge capture in time.')), timeoutMs);
      pending.set(id, { timer, finish });
      try { postMessage({ type: 'mail-call', id, captureId: identity, payload: event }); }
      catch (error) { finish(asError(error)); }
    });
  };
  const receive = message => {
    if (message?.type !== 'mail-result') return false;
    const request = pending.get(message.id);
    if (request) request.finish(message.error !== undefined
      ? asError(message.error) : message.value === true ? null : new Error('The local mail inbox rejected capture.'), true);
    return true;
  };
  const close = (error = new Error('The mail capture worker was closed.')) => {
    if (closed) return;
    closed = asError(error);
    for (const request of [...pending.values()]) request.finish(closed);
  };
  return { capture, receive, close };
}

/** Handle one packet immediately; forward its identity and ACK only host acceptance. */
export function replyToMailCapture(message, { capture, postMessage }) {
  if (message?.type !== 'mail-call') return false;
  void (async () => {
    let result;
    try {
      if (typeof message.id !== 'string' || !message.id
        || typeof message.captureId !== 'string' || !message.captureId) throw new TypeError('Invalid mail capture packet.');
      if (await capture(message.payload, message.captureId) !== true) throw new Error('The local mail inbox rejected capture.');
      result = { type: 'mail-result', id: message.id, value: true };
    } catch (error) {
      result = { type: 'mail-result', id: message.id, error: asError(error).message };
    }
    // A dead recipient cannot receive an error reply either; its client is closed
    // by lifecycle handling or rejects at the finite ACK deadline.
    try { postMessage(result); } catch { /* Recipient closed during capture. */ }
  })();
  return true;
}
