import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../scripts/prepare-adminer.mjs';
import { updateAdminer } from '../scripts/update-adminer.mjs';

test('a verified compatible Adminer update advances both pins and a repeated check needs no download', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'playground-adminer-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const dir = path.join(directory, 'dependencies/adminer');
  const runtime = path.join(directory, 'src/database/runtime.mjs');
  const pin = path.join(dir, 'provenance.json');
  await mkdir(dir, { recursive: true });
  await mkdir(path.dirname(runtime), { recursive: true });
  const upstream = new URL('../dependencies/adminer/', import.meta.url);
  const current = JSON.parse(await readFile(new URL('provenance.json', upstream)));
  const original = await readFile(new URL(current.asset, upstream));
  const previous = { ...current, version: '0.0.1', asset: 'adminer-0.0.1-mysql.php' };
  await writeFile(pin, JSON.stringify(previous));
  await writeFile(path.join(dir, previous.asset), 'previous release');
  await writeFile(runtime, "export const ADMINER_VERSION = '0.0.1';\n");
  const asset = { name: current.asset, browser_download_url: current.url, size: current.bytes, digest: 'sha256:' + current.sha256 };
  const release = { tag_name: 'v' + current.version, html_url: current.release, draft: false, prerelease: false, assets: [asset] };
  let payload = Buffer.from('invalid download');
  let downloads = 0;
  const request = async (url, headers) => {
    if (url === current.url) {
      assert.equal(headers, undefined);
      downloads++;
      return new Response(payload);
    }
    assert.equal(url, 'https://api.github.com/repos/vrana/adminer/releases/latest');
    assert.equal(headers.Authorization, 'Bearer metadata-only');
    return Response.json(release);
  };
  const options = { directory, request, token: 'metadata-only' };
  await assert.rejects(updateAdminer(options), /integrity/);
  payload = Buffer.from(original.toString().replace('PRIVILEGES],where,order', 'PRIVILEGES],order'));
  asset.digest = 'sha256:' + digest(payload);
  asset.size = payload.length;
  await assert.rejects(updateAdminer(options), /privileges boundary/);
  assert.deepEqual(JSON.parse(await readFile(pin)), previous);
  assert.deepEqual((await readdir(dir)).sort(), [previous.asset, 'provenance.json']);
  assert.match(await readFile(runtime, 'utf8'), /'0\.0\.1'/);

  payload = original;
  asset.digest = 'sha256:' + current.sha256;
  asset.size = current.bytes;
  assert.match(await updateAdminer(options), /Updated Adminer/);
  assert.deepEqual(JSON.parse(await readFile(pin)), current);
  assert.deepEqual(await readFile(path.join(dir, current.asset)), original);
  assert.deepEqual((await readdir(dir)).sort(), [current.asset, 'provenance.json']);
  assert.equal(await readFile(runtime, 'utf8'), `export const ADMINER_VERSION = '${current.version}';\n`);
  assert.match(await updateAdminer(options), /is current/);
  assert.equal(downloads, 3);
  asset.digest = 'sha256:' + '0'.repeat(64);
  await assert.rejects(updateAdminer(options), /Previously pinned Adminer release changed/);
});
