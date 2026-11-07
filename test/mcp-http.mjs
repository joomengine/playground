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
      const categories = await client.callTool('joomla_action_read', {
        action: 'content.categories.list', transport: 'api', input: { limit: 1 },
      });
      const ping = await client.request('ping');
      const frontend = await fetch(new URL('index.php', window.playground.baseUrl), { signal: AbortSignal.timeout(30_000) });
      const siteError = (await frontend.text()).match(/Fatal error|Uncaught (?:Error|Exception)|Call to undefined function/i)?.[0] ?? null;
      return { protocol: initialization.protocolVersion, tools: catalogue.tools.map(tool => tool.name),
        action: description.action?.id, categories,
        ping, siteStatus: frontend.status, siteError, healthy: window.playground.healthy };
    } finally { await client.close(); }
  });
  assert.equal(result.protocol, '2025-11-25');
  assert.ok(result.tools.includes('joomla_action_describe'));
  assert.ok(result.tools.includes('joomla_action_read'));
  assert.equal(result.action, 'content.categories.list');
  assert.equal(result.categories.action, 'content.categories.list');
  assert.equal(result.categories.transport, 'api', 'The read must execute through Joomla\'s nested HTTP API.');
  assert.equal(result.categories.response.status, 200);
  const categories = result.categories.response.data.data;
  assert.equal(categories.length, 1, 'The API must honor the requested one-category limit.');
  assert.equal(categories[0].type, 'categories');
  assert.equal(categories[0].id, '2');
  // This is the real content category installed by Joomla in the fresh deploy.
  const { id, title, alias, published } = categories[0].attributes;
  assert.deepEqual({ id, title, alias, published }, {
    id: 2, title: 'Uncategorised', alias: 'uncategorised', published: 1,
  });
  assert.deepEqual(result.ping, {});
  assert.equal(result.siteStatus, 200);
  assert.equal(result.siteError, null);
  assert.equal(result.healthy, true, 'A nested API operation must leave the site usable.');
  return { authenticatedHttp: true, discovery: true, actionDescription: true,
    nestedApiRead: true, categoryId: id, siteRemainsHealthy: true };
}
