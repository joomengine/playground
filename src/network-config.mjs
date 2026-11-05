import { NETWORK_PROTOCOL_VERSION } from './network-protocol.mjs';

function origin(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be an HTTP origin.`);
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) {
    throw new TypeError(`${name} must be an exact HTTP origin without a path.`);
  }
  return parsed.origin;
}

/** Only deployment-owned configuration is accepted here; never site/blueprint data. */
export function normalizeNetworkConfig(raw = {}, { allowInsecureLocalhost = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid public network configuration.');
  const publicKeys = new Set(['schemaVersion', 'enabled', 'endpoint', 'protocolVersion', 'turnstileSiteKey', 'proxyOrigins', 'credentialGrants', 'maxRedirects']);
  if (Object.keys(raw).some(key => !publicKeys.has(key))) throw new TypeError('Network configuration contains an unsupported or non-public setting.');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new TypeError('Unsupported network configuration schema.');
  if (raw.protocolVersion !== undefined && raw.protocolVersion !== NETWORK_PROTOCOL_VERSION) throw new TypeError('Unsupported network protocol version.');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new TypeError('Network enabled must be boolean.');
  const enabled = raw.enabled ?? false;
  let endpoint = null;
  if (raw.endpoint != null) {
    const parsed = new URL(raw.endpoint);
    const local = allowInsecureLocalhost && parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !local) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError('The network endpoint must be a trusted HTTPS URL.');
    endpoint = parsed.href.replace(/\/+$/, '');
  }
  if (enabled && !endpoint) throw new TypeError('An enabled network service requires an endpoint.');
  const proxyOrigins = raw.proxyOrigins ?? [];
  const credentialGrants = raw.credentialGrants ?? [];
  if (!Array.isArray(proxyOrigins) || !Array.isArray(credentialGrants)) throw new TypeError('Network policies must be arrays.');
  const maxRedirects = raw.maxRedirects ?? 5;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw new TypeError('Invalid network redirect limit.');
  if (raw.turnstileSiteKey != null && (typeof raw.turnstileSiteKey !== 'string' || !raw.turnstileSiteKey || raw.turnstileSiteKey.length > 256)) throw new TypeError('Invalid Turnstile site key.');
  return Object.freeze({
    schemaVersion: 1, enabled, endpoint, protocolVersion: NETWORK_PROTOCOL_VERSION,
    turnstileSiteKey: raw.turnstileSiteKey ?? null, maxRedirects,
    proxyOrigins: Object.freeze([...new Set(proxyOrigins.map(value => origin(value, 'Proxy destination')))]),
    credentialGrants: Object.freeze(credentialGrants.map(grant => {
      if (!grant || typeof grant !== 'object' || Object.keys(grant).some(key => !['relayOrigin', 'destinationOrigin'].includes(key))) throw new TypeError('Invalid credential forwarding grant.');
      return Object.freeze({ relayOrigin: origin(grant.relayOrigin, 'Credential relay'), destinationOrigin: origin(grant.destinationOrigin, 'Credential destination') });
    })),
  });
}
