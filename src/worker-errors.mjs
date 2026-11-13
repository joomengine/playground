/** Worker messages must distinguish failure from success even when a DOMException has no message. */
export function serializeWorkerError(cause, fallback = 'The worker operation failed.') {
  const name = typeof cause?.name === 'string' && cause.name ? cause.name : 'Error';
  const message = typeof cause?.message === 'string' && cause.message.trim() ? cause.message
    : typeof cause === 'string' && cause.trim() ? cause
      : name === 'QuotaExceededError' ? 'Browser storage rejected the write (QuotaExceededError).'
        : name !== 'Error' ? `${name}: ${fallback}` : fallback;
  const code = cause?.code;
  return { error: message, name, ...(['number', 'string'].includes(typeof code) ? { code } : {}) };
}
