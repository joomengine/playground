import assert from 'node:assert/strict';

/** Observe the repository mirrors advertised by the validated live discovery proof. */
export function repositoryHostsFromDiscovery(proof) {
  assert.ok(Array.isArray(proof) && proof.length, 'Discovery proof must contain responses.');
  const hosts = new Set();
  for (const response of proof) {
    assert.ok(Array.isArray(response?.networks) && response.networks.length,
      'Discovery proof must contain repository networks.');
    for (const network of response.networks) {
      assert.ok(Array.isArray(network?.mirrors) && network.mirrors.length,
        'Each discovered network must contain repository mirrors.');
      for (const mirror of network.mirrors) {
        assert.ok([0, 1].includes(mirror?.status), 'Discovered mirror health must be explicit.');
        let url;
        try { url = new URL(mirror.url); }
        catch { throw new TypeError('A discovered repository mirror must have a valid HTTPS URL.'); }
        assert.ok(url.protocol === 'https:' && url.hostname
          && !url.username && !url.password && !url.search && !url.hash,
        'Discovered mirrors must use public HTTPS URLs without credentials, queries or fragments.');
        hosts.add(url.hostname);
      }
    }
  }
  return hosts;
}

// Receipts contain only the public endpoints exercised by this gate.
export function publicNetworkURL(value, repositoryHosts) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || [...url.searchParams.keys()].some(key => key !== 'ref')) return null;
  if (url.hostname === 'api.joomlacomponentbuilder.com'
    && url.pathname.startsWith('/v1/network/')) return url.href;
  if (!(repositoryHosts instanceof Set) || !repositoryHosts.has(url.hostname)) return null;
  if (/\/api\/v1\/repos\/joomla\//.test(url.pathname)
    || /\/repos\/joomengine\/packages\//.test(url.pathname)
    || /\/joomengine\/packages\//.test(url.pathname)) return url.href;
  return null;
}

export function successfulRead(events, suffix, label) {
  // A rejected HTTP-200 challenge can precede the valid fallback response.
  // The PHP/client proof is already validated; report its final response.
  const read = events.findLast(event => event.event === 'response' && event.status === 200
    && !/text\/html/i.test(event.contentType)
    && decodeURIComponent(new URL(event.url).pathname).endsWith(suffix));
  assert.ok(read, `${label} must have an observed successful real repository response (${suffix}).`);
  const url = new URL(read.url);
  return { url: read.url, status: read.status, resolvedOrigin: url.origin,
    requestedRef: url.searchParams.get('ref') ?? null };
}
