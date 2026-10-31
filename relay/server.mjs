import http from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

// Initial URLs are intentionally narrower than redirect URLs.  In particular,
// callers cannot supply an arbitrary signed release-assets URL themselves.
const VERSION = '[0-9]+\\.[0-9]+\\.[0-9]+(?:-[A-Za-z0-9.-]+)?';
const nightly = new RegExp(`^/nightlies/Joomla_${VERSION}-Development-Full_Package\\.zip$`);
const joomlaRelease = new RegExp(`^/joomla/joomla-cms/releases/download/(${VERSION})/Joomla_(${VERSION})-(?:Stable|Alpha|Beta|RC|Release_Candidate)-Full_Package\\.zip$`, 'i');
const jcbTag = new RegExp(`^/joomengine/pkg-component-builder/archive/refs/tags/v${VERSION}\\.zip$`, 'i');
const jcbRedirect = new RegExp(`^/joomengine/pkg-component-builder/zip/refs/tags/v${VERSION}$`, 'i');
const releaseRedirect = /^\/github-production-release-asset\/\d+\/[A-Za-z0-9-]+$/;
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'binary/octet-stream']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function allowedSource(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search || url.pathname.includes('%')) return null;
  if (url.hostname === 'developer.joomla.org' && nightly.test(url.pathname)) return { url, kind: 'nightly' };
  const release = joomlaRelease.exec(url.pathname);
  if (url.hostname === 'github.com' && release && release[1].toLowerCase() === release[2].toLowerCase()) return { url, kind: 'joomla' };
  if (url.hostname === 'github.com' && jcbTag.test(url.pathname)) return { url, kind: 'jcb' };
  return null;
}

function allowedRedirect(url, source) {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.pathname.includes('%')) return false;
  if (source.kind === 'jcb' && url.hostname === 'codeload.github.com') {
    return !url.search && jcbRedirect.test(url.pathname)
      && url.pathname.replace('/zip/', '/archive/') + '.zip' === source.url.pathname;
  }
  if (source.kind === 'joomla' && url.hostname === 'release-assets.githubusercontent.com') {
    return releaseRedirect.test(url.pathname) && Boolean(url.search);
  }
  return false;
}

function validateOrigin(value) {
  const origin = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || (local && !['http:', 'https:'].includes(origin.protocol))
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('Allowed origins must be HTTPS origins (or localhost HTTP origins).');
  }
  return origin.origin;
}

export function createRelay({ allowedOrigins = ['https://playground.joomengine.org'], fetchImpl = fetch,
  maxBytes = 256 * 1024 * 1024, maxConcurrent = 8, timeoutMs = 120_000 } = {}) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) throw new TypeError('At least one origin is required.');
  const origins = new Set(allowedOrigins.map(validateOrigin));
  if (![maxBytes, maxConcurrent, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new TypeError('Relay limits must be positive integers.');
  let active = 0;
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origin && !origins.has(origin)) { res.writeHead(403).end('Origin not allowed.'); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      if (!origin || !['GET', 'HEAD'].includes(req.headers['access-control-request-method'])) { res.writeHead(403).end(); return; }
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '600' }).end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end(); return; }
    let request;
    try { request = new URL(req.url, 'http://relay.invalid'); } catch { res.writeHead(400).end('Invalid request.'); return; }
    const values = request.searchParams.getAll('url');
    if (request.pathname !== '/fetch' || values.length !== 1 || [...request.searchParams.keys()].some(key => key !== 'url') || values[0].length > 2048) {
      res.writeHead(400).end('Provide one approved package URL.'); return;
    }
    const source = allowedSource(values[0]);
    if (!source) { res.writeHead(400).end('Package URL is not allowed.'); return; }
    if (active >= maxConcurrent) { res.writeHead(503, { 'Retry-After': '5' }).end('Relay is busy.'); return; }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.on('aborted', cancel);
    res.on('close', cancel);
    let lastResponse;
    try {
      let url = source.url;
      let response;
      for (let count = 0; count <= 3; count++) {
        response = await fetchImpl(url, { method: req.method, redirect: 'manual', signal: controller.signal,
          headers: { Accept: 'application/zip, application/octet-stream' } });
        lastResponse = response;
        if (!REDIRECTS.has(response.status)) break;
        const location = response.headers.get('location');
        if (!location || count === 3) throw new Error('Invalid upstream redirect.');
        let next;
        try { next = new URL(location, url); } catch { throw new Error('Invalid upstream redirect.'); }
        if (!allowedRedirect(next, source)) throw new Error('Upstream redirect is not allowed.');
        await response.body?.cancel();
        url = next;
      }
      if (!response.ok || response.status !== 200) { res.writeHead(502).end('Upstream package unavailable.'); return; }
      const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (!ZIP_TYPES.has(type)) { res.writeHead(502).end('Upstream response is not a ZIP package.'); return; }
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') { res.writeHead(502).end('Unexpected upstream encoding.'); return; }
      const lengthHeader = response.headers.get('content-length');
      if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes)) {
        res.writeHead(502).end('Upstream package exceeds the size limit.'); return;
      }
      res.setHeader('Content-Type', type);
      if (lengthHeader !== null) res.setHeader('Content-Length', lengthHeader);
      res.writeHead(200);
      if (req.method === 'HEAD') { res.end(); return; }
      if (!response.body) throw new Error('Missing upstream body.');
      let total = 0;
      const limiter = new Transform({ transform(chunk, encoding, callback) {
        total += chunk.length;
        if (total > maxBytes) callback(new Error('Upstream package exceeds the size limit.'));
        else callback(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, res, { signal: controller.signal });
    } catch {
      if (!res.headersSent) res.writeHead(502).end('Unable to retrieve the upstream package.');
      else res.destroy();
    } finally {
      if (lastResponse?.body && !lastResponse.body.locked) await lastResponse.body.cancel().catch(() => {});
      clearTimeout(timer); req.off('aborted', cancel); res.off('close', cancel); active--;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.RELAY_PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('RELAY_PORT must be a valid TCP port.');
  const allowedOrigins = (process.env.RELAY_ALLOWED_ORIGINS || 'https://playground.joomengine.org').split(',').map(s => s.trim()).filter(Boolean);
  createRelay({ allowedOrigins }).listen(port, process.env.RELAY_HOST || '127.0.0.1', () => console.log(`Package relay listening on port ${port}`));
}
