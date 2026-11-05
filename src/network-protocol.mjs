/** Versioned HTTP relay framing. Bodies are never encoded in the metadata. */
export const NETWORK_PROTOCOL_VERSION = 1;
export const NETWORK_REQUEST_HEADER = 'X-Playground-Request';
export const NETWORK_RESPONSE_HEADER = 'X-Playground-Response';
export const MAX_NETWORK_METADATA_BYTES = 32768;

export class NetworkError extends Error {
  constructor(code, message = code, { status, retryAfter, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'NetworkError';
    this.code = code;
    const curlCodes = { UPSTREAM_TIMEOUT: 28, REQUEST_ABORTED: 42, RESPONSE_INCOMPLETE: 56 };
    if (curlCodes[code]) this.curlCode = curlCodes[code];
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function encodeNetworkMetadata(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > MAX_NETWORK_METADATA_BYTES) throw new NetworkError('REQUEST_TOO_LARGE', 'Relay metadata exceeds its size limit.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (encoded.length > MAX_NETWORK_METADATA_BYTES) throw new NetworkError('REQUEST_TOO_LARGE', 'Relay metadata exceeds its size limit.');
  return encoded;
}

export function decodeNetworkMetadata(value) {
  try {
    if (typeof value !== 'string' || !value || value.length > MAX_NETWORK_METADATA_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid metadata encoding.');
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || decoded.version !== NETWORK_PROTOCOL_VERSION) throw new Error('Unsupported relay protocol.');
    return decoded;
  } catch (cause) {
    throw new NetworkError('RELAY_PROTOCOL_ERROR', 'The network service returned invalid or unsupported metadata.', { cause });
  }
}
