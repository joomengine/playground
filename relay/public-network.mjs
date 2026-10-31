import { lookup as systemLookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export class RelayError extends Error {
  constructor(code, status = 502) { super(code); this.name = 'RelayError'; this.code = code; this.status = status; }
}

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}
function inV4(address, base, bits) {
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (ipv4Number(base) & mask) >>> 0;
}
function ipv6Number(address) {
  let text = address.toLowerCase();
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    const value = ipv4Number(text.slice(colon + 1));
    text = `${text.slice(0, colon)}:${(value >>> 16).toString(16)}:${(value & 65535).toString(16)}`;
  }
  const [left, right] = text.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const groups = right === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  return groups.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}
function inV6(address, base, bits) { return address >> BigInt(128 - bits) === ipv6Number(base) >> BigInt(128 - bits); }

/** Conservative public unicast policy; intentionally rejects transition networks. */
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4(value, base, bits));
  }
  if (family === 6) {
    const value = ipv6Number(address);
    return inV6(value, '2000::', 3) && ![
      ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
    ].some(([base, bits]) => inV6(value, base, bits));
  }
  return false;
}

export function validateUpstreamURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new RelayError('invalid-upstream-url', 400); }
  if (typeof value !== 'string' || url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new RelayError('invalid-upstream-url', 400);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.length > 253 || hostname.endsWith('.') || hostname.includes('%')) throw new RelayError('invalid-upstream-host', 400);
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new RelayError('non-public-destination', 403);
  return url;
}

function withAbort(promise, signal) {
  if (signal?.aborted) return Promise.reject(new RelayError('upstream-timeout', 504));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new RelayError('upstream-timeout', 504));
    signal?.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener('abort', aborted));
  });
}

export async function resolvePublicDestination(url, { lookup = systemLookup, signal } = {}) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  let addresses;
  try {
    addresses = literal ? [{ address: hostname, family: literal }] : await withAbort(lookup(hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('upstream-dns-failed');
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) {
    throw new RelayError('non-public-destination', 403);
  }
  // Pin the checked address into the actual TLS connection. Never resolve twice.
  return addresses[0];
}

/** Fetches original image bytes. It never accepts caller headers or a caller URL. */
export async function downloadApprovedAsset(asset, { lookup = systemLookup, request = https.request, signal, maxRedirects = 3 } = {}) {
  let url = validateUpstreamURL(asset.url);
  const redirects = new Set(asset.redirects ?? []);
  const visited = new Set();
  for (let hop = 0; ; hop++) {
    if (signal?.aborted) throw new RelayError('upstream-timeout', 504);
    if (visited.has(url.href)) throw new RelayError('redirect-loop');
    visited.add(url.href);
    const destination = await resolvePublicDestination(url, { lookup, signal });
    const response = await requestImage(url, destination, asset, { request, signal });
    if (response.redirect !== undefined) {
      if (hop >= maxRedirects) throw new RelayError('redirect-limit');
      let next;
      try { next = new URL(response.redirect, url).href; } catch { throw new RelayError('invalid-redirect'); }
      if (!redirects.has(next)) throw new RelayError('unapproved-redirect', 403);
      url = validateUpstreamURL(next);
      continue;
    }
    return response;
  }
}

function requestImage(url, destination, asset, { request, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    let outgoing;
    const abort = () => { finish(new RelayError('upstream-timeout', 504)); outgoing?.destroy(); };
    try {
      outgoing = request(url, {
        method: 'GET', agent: false, family: destination.family,
        servername: isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
        rejectUnauthorized: true,
        lookup(hostname, options, callback) {
          if (options?.all) callback(null, [destination]);
          else callback(null, destination.address, destination.family);
        },
        headers: { Accept: asset.mime, 'Accept-Encoding': 'identity', 'User-Agent': 'JoomEngine-Public-Image-Relay/1' },
      }, incoming => {
        if (settled) { incoming.destroy(); return; }
        const status = incoming.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = incoming.headers.location;
          incoming.destroy();
          finish(location ? null : new RelayError('missing-redirect-location'), { redirect: location });
          return;
        }
        if (status !== 200) { incoming.destroy(); finish(new RelayError(`upstream-status-${status || 0}`)); return; }
        const encoding = incoming.headers['content-encoding'];
        if (encoding && encoding !== 'identity') { incoming.destroy(); finish(new RelayError('unexpected-content-encoding')); return; }
        const type = String(incoming.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
        if (type !== asset.mime) { incoming.destroy(); finish(new RelayError('unexpected-image-type')); return; }
        const declared = incoming.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > asset.maxBytes)) {
          incoming.destroy(); finish(new RelayError('image-too-large', 413)); return;
        }
        let size = 0;
        const chunks = [];
        incoming.on('data', chunk => {
          if (settled) return;
          size += chunk.length;
          if (size > asset.maxBytes) { finish(new RelayError('image-too-large', 413)); incoming.destroy(); return; }
          chunks.push(chunk);
        });
        incoming.once('aborted', () => finish(new RelayError('incomplete-image')));
        incoming.once('error', () => finish(new RelayError('upstream-read-failed')));
        incoming.once('end', () => {
          if (declared !== undefined && Number(declared) !== size) { finish(new RelayError('incomplete-image')); return; }
          finish(null, { bytes: Buffer.concat(chunks, size), mime: type });
        });
      });
      outgoing.once('error', () => finish(new RelayError('upstream-connect-failed')));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      outgoing.end();
    } catch { finish(new RelayError('upstream-connect-failed')); }
  });
}
