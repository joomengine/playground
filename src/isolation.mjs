/** Shared by the page, workers and service worker. Never saved with a Joomla site. */
export const ISOLATION_BOOTSTRAP_VERSION = '20261031-1';
export const ISOLATION_PARAMETER = '__je_coep';
export const ISOLATION_POLICIES = Object.freeze(['credentialless', 'require-corp']);
export const RUNTIME_ROUTE = '__runtime/';

export function isolationMarker(value) {
  const url = new URL(value);
  const values = url.searchParams.getAll(ISOLATION_PARAMETER);
  if (values.length !== 1) return null;
  const match = /^([a-zA-Z0-9._-]{1,40}):(credentialless|require-corp)$/.exec(values[0]);
  return match ? Object.freeze({ version: match[1], policy: match[2] }) : null;
}

export function isolationNavigationURL(value, policy) {
  if (!ISOLATION_POLICIES.includes(policy)) throw new TypeError('Invalid browser isolation policy.');
  const url = new URL(value);
  url.searchParams.set(ISOLATION_PARAMETER, `${ISOLATION_BOOTSTRAP_VERSION}:${policy}`);
  return url.href;
}

export function isolationResponseHeaders(headers, policy = 'credentialless') {
  if (!ISOLATION_POLICIES.includes(policy)) throw new TypeError('Invalid browser isolation policy.');
  const result = new Headers(headers);
  result.set('Cross-Origin-Opener-Policy', 'same-origin');
  result.set('Cross-Origin-Embedder-Policy', policy);
  result.set('Cross-Origin-Resource-Policy', 'same-origin');
  result.set('X-JoomEngine-Bootstrap', ISOLATION_BOOTSTRAP_VERSION);
  return result;
}

function withinScope(url, scope) {
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

export function isOwnerClient(client, baseURL) {
  if (!client || client.type !== 'window' || !['top-level', 'none', undefined].includes(client.frameType)) return false;
  const scope = new URL(baseURL), url = new URL(client.url);
  if (!withinScope(url, scope)) return false;
  const path = url.pathname.slice(scope.pathname.length);
  return !['__site/', RUNTIME_ROUTE, '__public-assets/'].some(prefix => path.startsWith(prefix));
}

/** Static worker/module paths retain their owner through every relative import. */
export function ownedClientURL(value, { ownerId, baseURL } = {}) {
  const scope = new URL(baseURL);
  const url = new URL(value, scope);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId || '')) throw new TypeError('Invalid playground owner client.');
  if (!withinScope(url, scope)) throw new TypeError('A runtime resource must belong to this playground deployment.');
  const relative = url.pathname.slice(scope.pathname.length);
  if (relative.startsWith(RUNTIME_ROUTE)) {
    const currentOwner = relative.slice(RUNTIME_ROUTE.length).split('/')[0];
    if (currentOwner !== ownerId) throw new TypeError('A runtime resource belongs to another playground tab.');
    return url.href;
  }
  if (relative.startsWith('__site/') || relative.startsWith('__public-assets/')) throw new TypeError('Site and public-image requests use their own routes.');
  url.pathname = `${scope.pathname}${RUNTIME_ROUTE}${ownerId}/${relative}`;
  return url.href;
}

/** Return only a deployment-local static path; never turn this into a URL proxy. */
export function runtimeResource(value, baseURL) {
  const scope = new URL(baseURL), url = new URL(value, scope);
  const prefix = `${scope.pathname}${RUNTIME_ROUTE}`;
  if (url.origin !== scope.origin || !url.pathname.startsWith(prefix)) return null;
  const relative = url.pathname.slice(prefix.length);
  const slash = relative.indexOf('/');
  const ownerId = relative.slice(0, slash), resource = relative.slice(slash + 1);
  if (slash < 1 || !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId) || !resource
    || resource.includes('\\') || /%(?:2f|5c|00|2e)/i.test(resource)
    || resource.split('/').some(part => part === '.' || part === '..')
    || ['__site/', RUNTIME_ROUTE, '__public-assets/'].some(prefix => resource.startsWith(prefix))) {
    throw new TypeError('Invalid owned runtime route.');
  }
  url.pathname = `${scope.pathname}${resource}`;
  return { ownerId, url: url.href };
}

function clientOwnerId(client, scope) {
  if (!client) return null;
  const url = new URL(client.url);
  if (!withinScope(url, scope)) return null;
  for (const prefix of ['__site/', RUNTIME_ROUTE]) {
    if (url.pathname.startsWith(`${scope.pathname}${prefix}`)) {
      const id = url.pathname.slice(scope.pathname.length + prefix.length).split('/')[0];
      return /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null;
    }
  }
  return null;
}

/** Reconstruct policy from live ownership URLs after any service-worker restart. */
export async function resolveRequestIsolation(event, { baseURL, getClient } = {}) {
  const scope = new URL(baseURL), url = new URL(event.request.url);
  let ownerId;
  if (withinScope(url, scope)) {
    for (const prefix of ['__site/', RUNTIME_ROUTE]) {
      if (url.pathname.startsWith(`${scope.pathname}${prefix}`)) {
        ownerId = url.pathname.slice(scope.pathname.length + prefix.length).split('/')[0];
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId)) throw new TypeError('Invalid playground owner.');
        break;
      }
    }
  }
  if (ownerId) {
    const owner = await getClient(ownerId);
    if (!isOwnerClient(owner, scope.href)) throw new Error('This playground owner tab is closed or unavailable.');
    return { ownerId, policy: isolationMarker(owner.url)?.policy ?? 'credentialless' };
  }
  const client = event.clientId ? await getClient(event.clientId) : null;
  const inheritedOwner = clientOwnerId(client, scope);
  if (inheritedOwner) {
    const owner = await getClient(inheritedOwner);
    if (!isOwnerClient(owner, scope.href)) throw new Error('This playground owner tab is closed or unavailable.');
    return { ownerId: inheritedOwner, policy: isolationMarker(owner.url)?.policy ?? 'credentialless' };
  }
  // A navigation selects the next document's policy, never another tab's. Old
  // validated versions remain readable while an already running page updates SW.
  if (event.request.mode === 'navigate' && withinScope(url, scope)) {
    return { ownerId: event.resultingClientId || null, policy: isolationMarker(url.href)?.policy ?? 'credentialless' };
  }
  if (isOwnerClient(client, scope.href)) return { ownerId: client.id, policy: isolationMarker(client.url)?.policy ?? 'credentialless' };
  return { ownerId: null, policy: 'credentialless' };
}
