/** HTTP metadata accompanies raw, streamed bodies so PHP can read CORS-hidden headers. */
export const NETWORK_PROTOCOL_VERSION = 1;
export const NETWORK_REQUEST_HEADER = 'X-Playground-Request';
export const NETWORK_RESPONSE_HEADER = 'X-Playground-Response';

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
    if (decoded.version !== NETWORK_PROTOCOL_VERSION) throw new Error('Unsupported metadata version.');
    return decoded;
  } catch (cause) {
    throw new NetworkError('RELAY_PROTOCOL_ERROR', 'The HTTP proxy returned invalid response metadata.', { cause });
  }
}
