import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptAdminer } from './prepare-adminer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const upstream = 'https://github.com/vrana/adminer';
const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

async function get(url, headers) {
  const response = await fetch(url, { headers, redirect: headers ? 'error' : 'follow', signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Adminer download failed (${response.status}): ${url}`);
  return response;
}

export async function updateAdminer({ directory = root, request = get, token = process.env.GITHUB_TOKEN } = {}) {
  const dir = path.join(directory, 'dependencies/adminer');
  const provenanceFile = path.join(dir, 'provenance.json');
  const runtimeFile = path.join(directory, 'src/database/runtime.mjs');
  const current = JSON.parse(await readFile(provenanceFile, 'utf8'));
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const release = await (await request('https://api.github.com/repos/vrana/adminer/releases/latest', headers)).json();
  const version = release.tag_name?.slice(1);
  if (!stable.test(current.version) || !stable.test(version) || release.tag_name !== `v${version}`
    || release.draft !== false || release.prerelease !== false
    || release.html_url !== `${upstream}/releases/tag/v${version}`) {
    throw new Error('Unexpected Adminer stable release metadata.');
  }
  const previous = current.version.split('.').map(Number);
  const delta = version.split('.').map((n, i) => Number(n) - previous[i]).find(n => n !== 0);
  if (delta < 0) throw new Error(`Latest Adminer release ${version} is older than the pin ${current.version}.`);
  const asset = `adminer-${version}-mysql.php`;
  const url = `${upstream}/releases/download/v${version}/${asset}`;
  const match = release.assets?.find(item => item.name === asset && item.browser_download_url === url);
  if (!match || !/^sha256:[0-9a-f]{64}$/.test(match.digest)
    || !Number.isSafeInteger(match.size) || match.size <= 0) throw new Error(`Missing verified Adminer release asset: ${asset}`);
  const sha256 = match.digest.slice(7);
  if (version === current.version && (sha256 !== current.sha256 || match.size !== current.bytes)) {
    throw new Error(`Previously pinned Adminer release changed: ${version}`);
  }
  const provenance = { ...current, version, release: release.html_url, asset, url, bytes: match.size, sha256 };
  const original = version === current.version
    ? await readFile(path.join(dir, asset))
    : Buffer.from(await (await request(url)).arrayBuffer());
  await adaptAdminer(original, provenance);
  const header = original.subarray(0, 1024).toString('utf8').split('*/', 1)[0];
  if (!header.startsWith('<?php\n/** Adminer -') || !header.includes(`* @version ${version}\n`)
    || !header.includes('@license https://www.apache.org/licenses/LICENSE-2.0 Apache License, Version 2.0')
    || !header.includes('@license https://www.gnu.org/licenses/gpl-2.0.html GNU General Public License, version 2 (one or other)')) {
    throw new Error('Unexpected Adminer release version or license header.');
  }

  const runtime = await readFile(runtimeFile, 'utf8');
  const oldPin = `export const ADMINER_VERSION = '${current.version}';`;
  const newPin = `export const ADMINER_VERSION = '${version}';`;
  if (runtime.split(oldPin).length !== 2 && runtime.split(newPin).length !== 2) throw new Error('Unexpected Adminer runtime version pin.');
  if (version === current.version) return `Adminer ${version} is current.`;

  // Fully verify the new release before changing the checkout. Update the
  // provenance last so interrupted replacements can be run again safely.
  for (const [filename, content] of [
    [path.join(dir, asset), original],
    [runtimeFile, runtime.replace(oldPin, newPin)],
    [provenanceFile, JSON.stringify(provenance, null, 2) + '\n'],
  ]) {
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, content);
      await rename(temporary, filename);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await rm(path.join(dir, current.asset), { force: true });
  return `Updated Adminer ${current.version} to ${version}.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await updateAdminer());
