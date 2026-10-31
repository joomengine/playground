import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalPublicAssetURL, validatePublicAssetRegistry } from '../src/public-assets.mjs';
import { validateRelayConfig } from './server.mjs';
import { validateImageBytes } from './image-validation.mjs';

const usage = 'node relay/verify.mjs --base-url HTTPS_URL --config FILE --registry FILE [--origin ORIGIN] [--timeout-ms 20000] [--report FILE]';
const options = new Map();
const flags = new Set(['--base-url', '--config', '--registry', '--origin', '--timeout-ms', '--report']);
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1];
  if (!flags.has(flag) || !value || options.has(flag)) throw new Error(`Usage: ${usage}`);
  options.set(flag, value);
}
for (const flag of ['--base-url', '--config', '--registry']) if (!options.has(flag)) throw new Error(`Required ${flag}. Usage: ${usage}`);
const base = new URL(canonicalPublicAssetURL(options.get('--base-url')));
if (!base.pathname.endsWith('/') || base.search) throw new Error('Relay HTTPS base URL must end in / and have no query, credentials or fragment.');
const config = validateRelayConfig(JSON.parse(await readFile(options.get('--config'), 'utf8')));
const registry = validatePublicAssetRegistry(JSON.parse(await readFile(options.get('--registry'), 'utf8')));
if (!registry.assets.length) throw new Error('The reviewed registry contains no image assets to verify.');
const origin = options.get('--origin') ?? (config.allowedOrigins.length === 1 ? config.allowedOrigins[0] : undefined);
if (!origin || !config.allowedOrigins.includes(origin)) throw new Error('Select one of the relay configuration allowedOrigins using --origin.');
const timeoutMs = options.has('--timeout-ms') ? Number(options.get('--timeout-ms')) : 20000;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) throw new Error('timeout-ms must be an integer from 1000 to 45000.');

async function boundedBytes(response, maxBytes, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('invalid-content-length');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing-image-body');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('image-too-large');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (length !== null && Number(length) !== size) throw new Error('incomplete-image');
  return Buffer.concat(chunks, size);
}

const results = Array(registry.assets.length);
let cursor = 0;
async function worker() {
  while (cursor < registry.assets.length) {
    const index = cursor++, asset = registry.assets[index], start = Date.now();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const url = new URL(`v1/assets/${registry.version}/${asset.id}`, base);
      response = await fetch(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Origin: origin, Accept: asset.mime, 'Accept-Encoding': 'identity' },
      });
      if (response.status !== 200) throw new Error(`relay-status-${response.status}`);
      if (response.headers.get('access-control-allow-origin') !== origin) throw new Error('cors-origin-mismatch');
      if (response.headers.has('access-control-allow-credentials') || response.headers.has('set-cookie')) throw new Error('unexpected-credential-header');
      if (response.headers.get('x-content-type-options') !== 'nosniff') throw new Error('missing-nosniff');
      if (!response.headers.get('vary')?.toLowerCase().split(',').some(item => item.trim() === 'origin')) throw new Error('missing-vary-origin');
      if (response.headers.get('x-public-asset-id') !== asset.id || response.headers.get('x-public-asset-registry') !== registry.version) throw new Error('asset-identity-mismatch');
      const exposed = new Set((response.headers.get('access-control-expose-headers') || '').toLowerCase().split(',').map(value => value.trim()));
      if (['x-public-asset-id', 'x-public-asset-registry', 'x-public-asset-sha256'].some(name => !exposed.has(name))) throw new Error('missing-cors-exposed-headers');
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') throw new Error('unexpected-content-encoding');
      const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      const bytes = await boundedBytes(response, asset.maxBytes, controller.signal);
      const sha256 = validateImageBytes(bytes, asset, mime);
      if (response.headers.get('x-public-asset-sha256') !== sha256) throw new Error('relay-digest-mismatch');
      results[index] = { id: asset.id, outcome: 'verified', status: response.status, mime, bytes: bytes.length, sha256, md5: createHash('md5').update(bytes).digest('hex'), durationMs: Date.now() - start };
    } catch (error) {
      const code = controller.signal.aborted ? 'verification-timeout' : error.code || error.cause?.code || error.message || 'verification-failed';
      results[index] = { id: asset.id, outcome: 'failed', status: response?.status ?? null, code: String(code).slice(0, 160), durationMs: Date.now() - start };
      await response?.body?.cancel().catch(() => {});
    } finally { clearTimeout(timer); }
    process.stderr.write(`${results[index].outcome}: ${asset.id}${results[index].code ? ` (${results[index].code})` : ''}\n`);
  }
}
await Promise.all(Array.from({ length: Math.min(4, registry.assets.length) }, worker));
const verified = results.filter(result => result.outcome === 'verified').length;
const report = { checkedAt: new Date().toISOString(), node: process.version, relayBaseURL: base.href, origin,
  registryVersion: registry.version, concurrency: 4, timeoutMs, total: results.length, verified, failed: results.length - verified, results };
const json = `${JSON.stringify(report, null, 2)}\n`;
if (options.has('--report')) {
  const filename = path.resolve(options.get('--report'));
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, json);
}
process.stdout.write(json);
process.exitCode = report.failed ? 1 : 0;
