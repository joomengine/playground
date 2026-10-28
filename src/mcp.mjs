/** A same-browser client for the installed component's ordinary authenticated HTTP endpoint. */
export function createMcpClient({ request, token, endpoint = 'api/index.php/v1/joomengine-mcp' }) {
  if (typeof request !== 'function' || typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
    throw new TypeError('An HTTP request function and a Joomla API token are required.');
  }
  let sequence = 0;
  let session = '';
  let protocol = '2025-11-25';
  const exchange = async (body, method = 'POST') => {
    const headers = new Headers({ Accept: 'application/json, text/event-stream', 'X-Joomla-Token': token });
    if (method === 'POST') headers.set('Content-Type', 'application/json');
    if (session) {
      headers.set('Mcp-Session-Id', session);
      headers.set('MCP-Protocol-Version', protocol);
    }
    return request(endpoint, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  };
  const rpc = async (method, params = {}) => {
    const id = ++sequence;
    const response = await exchange({ jsonrpc: '2.0', id, method, params });
    // Response bodies can contain application data; diagnostics never include credentials or bodies.
    if (response.status !== 200) {
      await response.arrayBuffer();
      throw new Error(`MCP ${method} returned HTTP ${response.status}.`);
    }
    const result = await response.json();
    if (result.jsonrpc !== '2.0' || result.id !== id || result.error || !Object.hasOwn(result, 'result')) {
      throw new Error(`MCP ${method} did not return a successful JSON-RPC response.`);
    }
    return { result: result.result, headers: response.headers };
  };
  return {
    async initialize() {
      const response = await rpc('initialize', { protocolVersion: protocol, capabilities: {},
        clientInfo: { name: 'joomengine-playground', version: '0.1.0' } });
      if (typeof response.result.protocolVersion !== 'string') throw new Error('MCP did not negotiate a protocol version.');
      protocol = response.result.protocolVersion;
      session = response.headers.get('Mcp-Session-Id') || '';
      const notification = await exchange({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await notification.arrayBuffer();
      if (notification.status !== 202) throw new Error(`MCP initialization notification returned HTTP ${notification.status}.`);
      return response.result;
    },
    async request(method, params = {}) { return (await rpc(method, params)).result; },
    async callTool(name, args = {}) {
      const result = (await rpc('tools/call', { name, arguments: args })).result;
      if (result.isError) throw new Error(`MCP tool ${name} did not complete successfully.`);
      if (result.structuredContent !== undefined) return result.structuredContent;
      const text = result.content?.find(item => item.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error(`MCP tool ${name} did not return structured output.`);
      return JSON.parse(text);
    },
    async close() {
      if (!session) return;
      const response = await exchange(undefined, 'DELETE');
      await response.arrayBuffer();
      if (![200, 202, 204].includes(response.status)) throw new Error(`MCP session close returned HTTP ${response.status}.`);
      session = '';
    },
  };
}
