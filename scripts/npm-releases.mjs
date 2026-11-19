import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export const registry = 'https://registry.npmjs.org';
export const registryEntry = (name, version) => `${registry}/${encodeURIComponent(name)}/${version}`;

export async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw error;
      await delay(1000 * attempt);
    }
  }
}
export const metadata = async url => JSON.parse(await download(url));

// npm's latest dist-tag may move backwards when the publisher rolls back a release.
export function forwardVersion(name, current, candidate) {
  for (const version of [current, candidate]) assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, `Expected a stable release of ${name}`);
  const installed = current.split('.').map(BigInt);
  const available = candidate.split('.').map(BigInt);
  for (let i = 0; i < installed.length; i++) {
    if (available[i] > installed[i]) return candidate;
    if (available[i] < installed[i]) return current;
  }
  return current;
}
