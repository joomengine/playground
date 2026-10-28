import assert from 'node:assert/strict';

/** Verify the browser's service-worker HTTP route, without returning private credentials. */
export async function assertMcpHttp(page) {
  const result = await page.evaluate(async () => {
    const { createMcpClient } = await import('./src/mcp.mjs');
    const connection = await window.playground.getMcpConnection();
    const client = createMcpClient({ token: connection.token,
      request: (path, init) => fetch(new URL(path, window.playground.baseUrl), {
        ...init, signal: AbortSignal.timeout(30_000),
      }) });
    try {
      const initialization = await client.initialize();
      const catalogue = await client.request('tools/list');
      const description = await client.callTool('joomla_action_describe', { action: 'content.categories.list' });
      const start = performance.now();
      const unsupported = await client.request('tools/call', { name: 'joomla_action_read',
        arguments: { action: 'content.categories.list', input: { limit: 1 } } });
      const elapsedMs = performance.now() - start;
      const ping = await client.request('ping');
      const frontend = await fetch(new URL('index.php', window.playground.baseUrl), { signal: AbortSignal.timeout(30_000) });
      await frontend.arrayBuffer();
      return { protocol: initialization.protocolVersion, tools: catalogue.tools.map(tool => tool.name),
        action: description.action?.id, unsupportedRejected: unsupported.isError === true, elapsedMs,
        ping, siteStatus: frontend.status, healthy: window.playground.healthy };
    } finally { await client.close(); }
  });
  assert.equal(result.protocol, '2025-11-25');
  assert.ok(result.tools.includes('joomla_action_describe'));
  assert.equal(result.action, 'content.categories.list');
  assert.equal(result.unsupportedRejected, true, 'Nested API execution must not report success.');
  assert.ok(result.elapsedMs < 10_000, 'Unsupported nested PHP calls must fail promptly instead of deadlocking.');
  assert.deepEqual(result.ping, {});
  assert.equal(result.siteStatus, 200);
  assert.equal(result.healthy, true, 'An unsupported operation must leave the site usable.');
  return { authenticatedHttp: true, discovery: true, actionDescription: true, nestedRequestRejected: true, siteRemainsHealthy: true };
}
