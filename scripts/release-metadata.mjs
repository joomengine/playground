import { setTimeout as delay } from 'node:timers/promises';

export async function readReleaseMetadata(url, fetchImpl, token) {
  const headers = { 'User-Agent': 'JoomEngine-Playground' };
  if (token && new URL(url).origin === 'https://api.github.com') headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (response.ok) return await response.text();
      await response.body?.cancel();
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw new Error(`HTTP ${response.status} for ${url}`);
      if (attempt === 3) throw new Error(`HTTP ${response.status} for ${url} after three attempts`);
    } catch (error) {
      if (attempt === 3 || !(error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
    }
    await delay(500 * attempt);
  }
}
