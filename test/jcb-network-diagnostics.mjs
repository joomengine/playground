import { sanitizeDiagnostic } from '../src/provisioning-errors.mjs';

/** Diagnostic receipts retain errors, never the test account's credentials. */
export function jcbDiagnosticText(value, secrets = [], maximum = 8192) {
  let text = String(value ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  return sanitizeDiagnostic(text, maximum);
}
