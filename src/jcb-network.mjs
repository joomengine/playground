// Network API health describes server access. A browser can reach a different
// advertised mirror because its requests also require CORS permission.
const hosts = new Set(['codeberg.org', 'git.disroot.org', 'git.envs.net', 'git.vdm.dev', 'tildegit.org']);
const repositories = new Set(['super-powers', 'joomla-powers', 'gitea', 'phpseclib', 'openai', 'search', 'packages']);
// These portable entities share JCB's GUID-indexed item.json contract. Child
// records, named custom code and binary files have different identities/formats.
const entities = new Map(['admin-view', 'class-extends', 'class-method', 'class-property', 'joomla-component',
  'custom-admin-view', 'dynamic-get', 'field', 'joomla-module', 'joomla-plugin', 'joomla-plugin-group',
  'layout', 'library', 'site-view', 'template'].map(name => [name, name.replaceAll('-', '_')]));
const publicHeaders = new Set(['accept', 'accept-language', 'content-type', 'user-agent']);
const guidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxBytes = 4 * 1024 * 1024;

function publicRead(input, init) {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : input);
  const method = String(init?.method ?? request?.method ?? 'GET').toUpperCase();
  const credentials = init?.credentials ?? request?.credentials;
  const mode = init?.mode ?? request?.mode;
  const headers = new Headers(init?.headers ?? request?.headers);
  if (method !== 'GET' || init?.body != null || request?.body != null || credentials === 'include'
    || mode && mode !== 'cors' || (init?.integrity ?? request?.integrity)
    || [...headers.keys()].some(name => !publicHeaders.has(name))
    || headers.has('content-type') && headers.get('content-type').split(';')[0].trim().toLowerCase() !== 'application/json'
    || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !hosts.has(url.hostname)) return null;
  const match = /^\/api\/v1\/repos\/joomla\/([a-z-]+)\/raw\/(.+)$/.exec(url.pathname);
  if (!match || !repositories.has(match[1]) || !safePath(match[2])
    || [...url.searchParams.keys()].some(name => name !== 'ref') || url.searchParams.getAll('ref').length !== 1) return null;
  const ref = url.searchParams.get('ref');
  if (!ref || ref.length > 128 || !/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.includes('..')) return null;
  const repository = match[1], file = match[2];
  let index = repository === 'joomla-powers' ? 'index.json' : 'super-powers.json', entity;
  if (repository === 'packages') {
    const indexMatch = /^index\/([a-z-]+)\.json$/.exec(file);
    const itemMatch = /^src\/([a-z_]+)\/([a-f0-9-]+)\/item\.json$/.exec(file);
    const name = indexMatch?.[1] ?? itemMatch?.[1].replaceAll('_', '-');
    entity = entities.get(name);
    if (!entity || itemMatch && !guidPattern.test(itemMatch[2])) return null;
    index = `index/${name}.json`;
  }
  return { url, repository, file, index, entity, key: `${repository}:${ref}:${index}`, signal: init?.signal ?? request?.signal };
}

function safePath(value) {
  return typeof value === 'string' && value.length < 512 && /^[a-zA-Z0-9_./-]+$/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..');
}

async function readText(response, signal) {
  if (response.status !== 200 || response.type === 'opaque' || /text\/html/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('The repository returned an error or an HTML page.');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('Repository response is too large.');
  const copy = response.clone(), reader = copy.body?.getReader();
  if (!reader) throw new Error('The repository returned no content.');
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks = []; let lengthRead = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      lengthRead += value.byteLength;
      if (lengthRead > maxBytes) throw new Error('Repository response is too large.');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(lengthRead); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim() || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) throw new Error('The repository returned an invalid file.');
  return text;
}

function indexFiles(text, { repository, entity }) {
  const index = JSON.parse(text);
  if (!index || typeof index !== 'object' || Array.isArray(index)
    || !Object.keys(index).length || Object.keys(index).length > 10000) throw new Error('Invalid repository index.');
  const files = new Map();
  for (const [guid, entry] of Object.entries(index)) {
    const item = repository === 'joomla-powers' || repository === 'packages';
    const expectedPath = entity ? `src/${entity}/${guid}` : `src/${guid}`;
    if (!guidPattern.test(guid) || !entry || entry.guid !== guid || entry.path !== expectedPath) throw new Error('Invalid repository index entry.');
    const settings = `${entry.path}/${item ? 'item' : 'settings'}.json`;
    if (entry.settings !== settings) throw new Error('Invalid repository settings path.');
    files.set(settings, { guid, json: true });
    if (!item) {
      if (entry.power !== `${entry.path}/code.power`) throw new Error('Invalid Power source path.');
      files.set(entry.power, { guid, json: false });
    }
  }
  return files;
}

function advertisedMirrors(data, repository) {
  if (data?.target !== repository || !Array.isArray(data.network) || data.network.length > 20) throw new Error('Invalid JCB network discovery.');
  const mirrors = new Map();
  for (const entry of data.network) {
    if (![0, 1].includes(entry?.status) || typeof entry.url !== 'string') continue;
    let url;
    try { url = new URL(entry.url); } catch { continue; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash
      || !hosts.has(url.hostname) || url.pathname !== `/joomla/${repository}`) continue;
    mirrors.set(url.origin, { origin: url.origin, status: entry.status });
  }
  return [...mirrors.values()].sort((a, b) => b.status - a.status);
}

async function bounded(signal, milliseconds, operation) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Repository request timed out.', 'TimeoutError')), milliseconds);
  try { return await operation(controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function anonymousOptions(signal) {
  return { method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    cache: 'no-store', headers: { Accept: 'application/json, text/plain, */*' }, signal };
}

/** Public core Power and GUID entity reads only. No relay, API rewriting or credentials. */
export function createJcbRepositoryFetch(fetcher, { timeoutMs = 30000, attemptTimeoutMs = 10000, now = Date.now } = {}) {
  const selections = new Map(), discovery = new Map();
  const select = (key, value) => {
    selections.delete(key);
    if (selections.size >= 32) selections.delete(selections.keys().next().value);
    selections.set(key, value);
  };
  async function validate(response, read, signal) {
    try { return indexFiles(await readText(response, signal), read); }
    catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
  }
  return async (input, init) => {
    let read;
    try { read = publicRead(input, init); } catch { /* Ordinary Fetch validates other inputs. */ }
    if (!read) return fetcher(input, init);
    read.signal?.throwIfAborted();
    if (read.file !== read.index) {
      const selected = selections.get(read.key), file = selected?.files.get(read.file);
      if (!file) return fetcher(input, init);
      // Keep every indexed file on the mirror selected for this index. Switching
      // only a failed file could combine different versions of a mutable branch.
      return bounded(read.signal, attemptTimeoutMs, async signal => {
        const response = selected.origin === read.url.origin ? await fetcher(input, { ...init, signal })
          : await fetcher(new URL(read.url.pathname + read.url.search, selected.origin).href, anonymousOptions(signal));
        try {
          const text = await readText(response, signal);
          if (file.json && JSON.parse(text)?.guid !== file.guid) throw new Error('Repository settings GUID does not match the index.');
          return response;
        } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      });
    }
    selections.delete(read.key);
    let originalError;
    try {
      // Preserve the original URL, headers and options; compose cancellation so
      // a stalled public mirror cannot prevent trying the remaining mirrors.
      const result = await bounded(read.signal, attemptTimeoutMs, async signal => {
        const response = await fetcher(input, { ...init, signal });
        return { response, files: await validate(response, read, signal) };
      });
      select(read.key, { origin: read.url.origin, files: result.files });
      return result.response;
    } catch (error) {
      read.signal?.throwIfAborted();
      originalError = error;
    }
    const attempted = [read.url.hostname], deadline = now() + timeoutMs;
    try {
      let mirrors = discovery.get(read.repository);
      if (!mirrors || mirrors.expires <= now()) {
        const entries = await bounded(read.signal, Math.min(attemptTimeoutMs, timeoutMs), async signal => {
          const response = await fetcher(`https://api.joomlacomponentbuilder.com/v1/network/community/jcb/${read.repository}`, anonymousOptions(signal));
          try { return advertisedMirrors(JSON.parse(await readText(response, signal)), read.repository); }
          catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
        });
        mirrors = { entries, expires: now() + 60000 };
        discovery.set(read.repository, mirrors);
      }
      for (const mirror of mirrors.entries) {
        if (mirror.origin === read.url.origin || now() >= deadline) continue;
        read.signal?.throwIfAborted();
        attempted.push(new URL(mirror.origin).hostname);
        try {
          const result = await bounded(read.signal, Math.min(attemptTimeoutMs, deadline - now()), async signal => {
            const response = await fetcher(new URL(read.url.pathname + read.url.search, mirror.origin).href, anonymousOptions(signal));
            return { response, files: await validate(response, read, signal) };
          });
          select(read.key, { origin: mirror.origin, files: result.files });
          return result.response;
        } catch { read.signal?.throwIfAborted(); }
      }
    } catch { read.signal?.throwIfAborted(); }
    throw new TypeError(`JCB public ${read.repository} repository could not be read from the browser. Tried: ${attempted.join(', ')}.`, { cause: originalError });
  };
}
