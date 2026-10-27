import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadVerified(url, expected, destination) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid SHA-256 for ${url}`);
  try {
    if (await hashFile(destination) === expected) return destination;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (new URL(url).protocol !== 'https:') throw new Error(`Download requires HTTPS: ${url}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`SHA-256 mismatch: ${url}`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  return destination;
}

export function safeArchivePath(name) {
  name = name.replace(/\/$/, '');
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
    || name.split('/').some(part => part === '..' || part === '.' || part === '') || /[\x00-\x1f]/.test(name)) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Extract only regular files and directories, never archive links or devices. */
export async function extractTarGzip(archive, destination) {
  const tar = gunzipSync(await readFile(archive), { maxOutputLength: 256 * 1024 * 1024 });
  const names = new Set();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
    const checksum = Number.parseInt(string(148, 8).trim(), 8);
    let actual = 0;
    for (let index = 0; index < 512; index++) actual += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== actual) throw new Error('Invalid tar header checksum');
    const name = safeArchivePath([string(345, 155), string(0, 100)].filter(Boolean).join('/'));
    if (names.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
    names.add(name);
    const size = Number.parseInt(string(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error(`Invalid archive size: ${name}`);
    const type = string(156, 1);
    const target = path.join(destination, name);
    if (type === '5') await mkdir(target, { recursive: true });
    else if (type === '' || type === '0') {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(offset + 512, offset + 512 + size));
    } else throw new Error(`Unsupported archive entry type ${type}: ${name}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

export async function inventory(directory, prefix = '') {
  const files = [];
  for (const name of (await readdir(path.join(directory, prefix))).sort()) {
    const relative = path.posix.join(prefix, name);
    const filename = path.join(directory, relative);
    const stat = await lstat(filename);
    if (stat.isDirectory()) files.push(...await inventory(directory, relative));
    else if (stat.isFile()) files.push({ path: relative, size: stat.size, sha256: await hashFile(filename) });
    else throw new Error(`Non-regular asset: ${relative}`);
  }
  return files;
}

export async function verifyBridgeBundle(directory, expected) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'bridge-manifest.json'), 'utf8'));
  if (manifest.bridgeVersion !== expected.version || manifest.protocolVersion !== expected.protocolVersion
    || manifest.sourceCommit !== expected.sourceCommit) throw new Error('Bridge release identity mismatch');
  const actual = (await inventory(directory)).filter(file => file.path !== 'bridge-manifest.json');
  const declared = manifest.files;
  if (!declared || Object.keys(declared).length !== actual.length) throw new Error('Bridge release inventory mismatch');
  for (const file of actual) {
    const record = declared[file.path];
    if (!record || record.sha256 !== file.sha256 || record.bytes !== file.size) throw new Error(`Bridge asset mismatch: ${file.path}`);
  }
  return manifest;
}
