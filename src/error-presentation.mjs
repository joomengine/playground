import { sanitizeDiagnostic } from './provisioning-errors.mjs';

/** Keep runtime documents out of the primary UI and credentials out of exports. */
export function presentError(error, { secrets = [], fallback = 'The operation could not finish. Open Technical details for more information.' } = {}) {
  const redact = value => {
    let text = String(value ?? '');
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return sanitizeDiagnostic(text);
  };
  const message = redact(error instanceof Error ? error.message : error);
  const rawDocument = /<!doctype|<\/?(?:html|head|body|style|script|div|pre)\b|__JOOMENGINE_RESULT__/i.test(message);
  const summary = rawDocument || message.length > 700 ? fallback : message;
  const metadata = [
    error?.phase && `Phase: ${error.phase}`,
    error?.packageUrl && `Package: ${error.packageUrl}`,
    error?.executionTimeSeconds && `Installation allowance: ${error.executionTimeSeconds} seconds`,
    error?.timeoutMs && `Host deadline: ${error.timeoutMs / 1000} seconds`,
  ].filter(Boolean).join('\n');
  const details = redact([metadata, error?.technicalDetails || (summary !== message ? message : '')].filter(Boolean).join('\n\n'));
  return { summary: summary || fallback, details };
}
