/** Original Apache-2.0 code. This service deliberately supports reviewed origins only. */
export class RelayError extends Error {
  constructor(code, message, status = 400, retryAfter) {
    super(message); this.name = 'RelayError'; this.code = code; this.status = status; this.retryAfter = retryAfter;
  }
}
export const VERSION = 1;
export const METADATA_LIMIT = 32768;
export const REQUEST_HEADER = 'X-Playground-Request';
export const RESPONSE_HEADER = 'X-Playground-Response';
export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
export const DEFAULT_LIMITS = Object.freeze({
  sessionMs: 1800000, maxSessionMs: 7200000, renewalMs: 60000,
  concurrent: 4, requestsPerMinute: 300, uploadBytes: 8388608,
  responseBytes: 67108864, sessionBytes: 536870912, redirects: 5,
  headerMs: 20000, idleMs: 30000, totalMs: 120000,
  issuancePerHour: 10, issuanceGlobalPerHour: 1000,
  globalRequestsPerDay: 100000, globalBytesPerDay: 10737418240,
});
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export function encodeMetadata(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (encoded.length > METADATA_LIMIT) throw new RelayError('METADATA_TOO_LARGE', 'HTTP metadata exceeds the relay limit.', 413);
  return encoded;
}
export function decodeMetadata(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > METADATA_LIMIT || !/^[\w-]+$/.test(encoded)) {
    throw new RelayError('INVALID_METADATA', 'Invalid request metadata.');
  }
  try {
    const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), x => x.charCodeAt(0));
    const value = JSON.parse(decoder.decode(bytes));
    if (value?.version !== VERSION) throw new RelayError('UNSUPPORTED_PROTOCOL_VERSION', 'Unsupported relay protocol version.');
    return value;
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('INVALID_METADATA', 'Invalid request metadata.');
  }
}
function jsonSetting(value, fallback) {
  if (value == null || value === '') return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}
function parsePublicURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw new RelayError('DESTINATION_NOT_ALLOWED', 'The destination URL is invalid.', 403);
  }
  let url; try { url = new URL(value); } catch { throw new RelayError('DESTINATION_NOT_ALLOWED', 'The destination URL is invalid.', 403); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || !host.includes('.') || host.endsWith('.') || host.includes(':') || /^[\d.]+$/.test(host)
    || /(^|\.)(localhost|local|internal|invalid|test|onion)$/.test(host)
    || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/.test(host)
    || host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    throw new RelayError('DESTINATION_NOT_ALLOWED', 'The destination is not a permitted public hostname.', 403);
  }
  return url;
}
function originList(value, { upstream = false } = {}) {
  const list = jsonSetting(value, []);
  if (!Array.isArray(list) || list.length > 256) throw new Error('Origin settings must be arrays containing at most 256 exact origins.');
  return new Set(list.map(value => {
    const url = upstream ? parsePublicURL(value) : new URL(value);
    if (url.origin !== value || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Expected an exact HTTP(S) origin.');
    return value;
  }));
}
export function readPolicy(env) {
  try {
    const limits = { ...DEFAULT_LIMITS, ...jsonSetting(env.LIMITS, {}) };
    for (const [key, value] of Object.entries(limits)) {
      if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER / 4) throw new Error('Invalid relay limit.');
    }
    if (limits.redirects > 20 || limits.totalMs > 120000 || limits.sessionMs > 1800000 || limits.maxSessionMs > 7200000 || limits.sessionMs > limits.maxSessionMs) throw new Error('Invalid relay deadline or session limit.');
    const audience = env.RELAY_AUDIENCE || '';
    if (audience && new URL(audience).origin !== audience) throw new Error('RELAY_AUDIENCE must be an exact origin.');
    const allowedOrigins = originList(env.ALLOWED_ORIGINS);
    const upstreamOrigins = originList(env.UPSTREAM_ORIGINS, { upstream: true });
    const credentialOrigins = originList(env.CREDENTIAL_ORIGINS, { upstream: true });
    if ([...credentialOrigins].some(origin => !upstreamOrigins.has(origin))) throw new Error('Credential origins must be approved upstream origins.');
    const ports = new Set(jsonSetting(env.ALLOWED_PORTS, [80, 443]));
    if ([...ports].some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid allowed port.');
    const methods = jsonSetting(env.ALLOWED_METHODS, METHODS);
    if (!Array.isArray(methods) || !methods.length || methods.some(method => !METHODS.includes(method))) throw new Error('Invalid method policy.');
    const revoked = jsonSetting(env.REVOKED_SESSION_IDS, []);
    if (!Array.isArray(revoked)) throw new Error('Invalid revocation list.');
    const enabled = env.ENABLED === 'true';
    if (enabled && (!audience || !allowedOrigins.size || !upstreamOrigins.size || !env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_ACTION || !env.POLICY_VERSION)) throw new Error('Enabled relay configuration is incomplete.');
    if (env.DEPLOYMENT_ENV === 'production' && /^[123]x0{20,}/.test(env.TURNSTILE_SECRET_KEY || '')) throw new Error('Turnstile test credentials are forbidden in production.');
    return { enabled, audience, allowedOrigins, upstreamOrigins, credentialOrigins, ports, methods, revoked: new Set(revoked), limits, policyVersion: String(env.POLICY_VERSION || ''), action: env.TURNSTILE_ACTION };
  } catch {
    throw new RelayError('RELAY_CONFIGURATION_INVALID', 'The network service configuration is invalid.', 503);
  }
}
export function validateDestination(value, policy, relayOrigin) {
  const url = parsePublicURL(value);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (!policy.upstreamOrigins.has(url.origin) || !policy.ports.has(port) || url.origin === relayOrigin || url.origin === policy.audience) {
    throw new RelayError('DESTINATION_NOT_ALLOWED', 'The destination is not permitted by the network service.', 403);
  }
  return url;
}
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'origin', 'referer', 'cookie2']);
export const ANONYMOUS_HEADERS = new Set(['accept', 'accept-language', 'accept-encoding', 'cache-control', 'content-type', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'if-range', 'range', 'user-agent', 'pragma']);
export function requestHeaders(metadata, policy, url) {
  if (!Array.isArray(metadata.headers) || metadata.headers.length > 128) throw new RelayError('INVALID_METADATA', 'Invalid upstream headers.');
  const headers = new Headers();
  for (const pair of metadata.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw new RelayError('INVALID_METADATA', 'Invalid upstream headers.');
    const name = pair[0].toLowerCase();
    if (HOP_HEADERS.has(name) || name.startsWith('sec-') || name.startsWith('cf-') || name.startsWith('x-playground-') || name.startsWith('x-relay-')) throw new RelayError('HEADER_NOT_ALLOWED', 'An upstream request header is not supported.', 400);
    if (!ANONYMOUS_HEADERS.has(name) && (metadata.forwardCredentials !== true || !policy.credentialOrigins.has(url.origin))) throw new RelayError('CREDENTIALS_NOT_ALLOWED', 'Credential forwarding is not approved for this destination.', 403);
    try { headers.append(pair[0], pair[1]); } catch { throw new RelayError('INVALID_METADATA', 'Invalid upstream headers.'); }
  }
  return headers;
}
export function responseHeaders(headers, decoded) {
  const result = [];
  for (const [name, value] of headers) {
    if (HOP_HEADERS.has(name) && name !== 'content-length') continue;
    if (name === 'set-cookie') continue;
    if (decoded && ['content-length', 'content-encoding'].includes(name)) continue;
    result.push([name, value]);
  }
  const cookies = headers.getSetCookie?.() ?? headers.getAll?.('Set-Cookie') ?? (headers.has('set-cookie') ? [headers.get('set-cookie')] : []);
  for (const cookie of cookies) result.push(['set-cookie', cookie]);
  return result;
}
