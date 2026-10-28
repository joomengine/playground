import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateDashboardImage } from '../scripts/jcb-dashboard-assets.mjs';

test('bundled JCB community artwork retains reviewed original bytes without active or external SVG resources', async () => {
  const directory = new URL('../dependencies/jcb-dashboard-assets/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('assets.json', directory)));
  assert.equal(manifest.assets.length, 30);
  assert.equal(manifest.readmeLinks.length, 24);
  for (const asset of manifest.assets) {
    const bytes = new Uint8Array(await readFile(new URL(asset.file, directory)));
    assert.equal(bytes.byteLength, asset.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    validateDashboardImage(bytes, asset.mime);
  }
});

test('community SVG validation rejects scripts, event handlers and external nested resources', () => {
  const validate = svg => validateDashboardImage(new TextEncoder().encode(svg), 'image/svg+xml');
  for (const svg of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><image href="https://example.com/external.png"/></svg>',
    '<svg><style>path{fill:url(https://example.com/paint)}</style></svg>',
    `<svg><image href="data:image/svg+xml;base64,${Buffer.from('<svg><image href="https://example.com/image.png"/></svg>').toString('base64')}"/></svg>`,
  ]) assert.throws(() => validate(svg));
  assert.doesNotThrow(() => validate('<svg><a href="https://example.com/contributor"><path d="M0 0"/></a></svg>'));
});
