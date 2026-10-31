/** Safe, bounded diagnostics for installer failures. Never insert these as HTML. */
export function sanitizeDiagnostic(value, maximum = 8192) {
  const clean = String(value ?? '')
    .replace(/\b(authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2[redacted]')
    .replace(/\\"/g, '"').replace(/\\[nr]/g, '\n')
    .replace(/https?:\/\/[^\s<>"'\\]+/gi, value => {
      try {
        const url = new URL(value);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.href;
      } catch { return '[redacted URL]'; }
    })
    .replace(/((?:password|passwd|token|secret|authorization|cookie|api[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;<]+)/gi, '$1[redacted]')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  return clean.length > maximum ? `${clean.slice(0, maximum - 15)}\n[truncated]` : clean;
}

export function packageLabel(value) {
  if (!value) return 'Extension package';
  return sanitizeDiagnostic(value, 240);
}

export function provisioningError(message, { technicalDetails = '', ...context } = {}) {
  const error = new Error(sanitizeDiagnostic(message, 500));
  error.technicalDetails = sanitizeDiagnostic(technicalDetails);
  Object.assign(error, context);
  return error;
}

export function conciseFailure(value, fallback = 'Joomla could not complete the operation.') {
  const text = sanitizeDiagnostic(value, 300).trim();
  return text && !/<[!/?a-z][^>]*>/i.test(text) ? text : fallback;
}
