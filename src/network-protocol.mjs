/** HTTP metadata accompanies raw, streamed bodies so PHP can read CORS-hidden headers. */
// Version 2 declares scoped credential headers. New clients must not silently
// send those requests through a version 1 relay with older redirect semantics.
export const NETWORK_PROTOCOL_VERSION = 2;
export const NETWORK_REQUEST_HEADER = 'X-Playground-Request';
export const NETWORK_RESPONSE_HEADER = 'X-Playground-Response';

const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization', 'private-token', 'job-token', 'deploy-token', 'x-api-key', 'x-auth-token'];

/** Callers declare unusual credential headers instead of relying on a token-name guess. */
export function networkCredentialHeaders(headers, declared = []) {
  if (!Array.isArray(declared) || declared.some(name => typeof name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))) {
    throw new TypeError('Invalid credential header names.');
  }
  const values = headers instanceof Headers ? headers : new Headers(headers);
  return [...new Set([...CREDENTIAL_HEADERS, ...declared.map(name => name.toLowerCase())])].filter(name => values.has(name));
}

export class NetworkError extends Error {
  constructor(code, message = code, { status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NetworkError';
    this.code = code;
    const curlCode = { UPSTREAM_TIMEOUT: 28, REQUEST_ABORTED: 42, RESPONSE_INCOMPLETE: 56, TOO_MANY_REDIRECTS: 47 }[code];
    if (curlCode) this.curlCode = curlCode;
    if (status !== undefined) this.status = status;
  }
}

export function encodeNetworkMetadata(value) {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeNetworkMetadata(value) {
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
    if (![1, NETWORK_PROTOCOL_VERSION].includes(decoded.version)) throw new Error('Unsupported metadata version.');
    return decoded;
  } catch (cause) {
    throw new NetworkError('RELAY_PROTOCOL_ERROR', 'The HTTP proxy returned invalid response metadata.', { cause });
  }
}
