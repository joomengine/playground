# JoomEngine MCP in a browser deployment

The `jcb-mcp` deploy installs the pinned [JoomEngine MCP package](https://github.com/joomengine/mcp_package/tree/v1.0.10) alongside JCB on Joomla 6. Joomla 5 selects the JCB-only deploy. The source archive and SHA-256 are recorded in `deploys/jcb-mcp.json`; the package supplies its component, console plugin and webservices plugin unchanged.

PHP loads the real Sodium extension required by the package. A fresh deployment configures the component's canonical API URL and generates a native Joomla API token through Joomla's user-token plugin. The token is private to the site, persists with Joomla's user profile, and is omitted from shared URLs, activity logs and installation diagnostics.

The endpoint is `<site>/api/index.php/v1/joomengine-mcp`. A client running in the same browser can use ordinary HTTP requests with `X-Joomla-Token` or `Authorization: Bearer`. The playground handle's `getMcpConnection()` authenticates the administrator and returns the current endpoint and native token on demand; `createMcpClient` in `src/mcp.mjs` manages the HTTP handshake, JSON-RPC requests and session cleanup. Neither helper changes the installed package's authentication, ACL or execution handlers. Accounts requiring interactive MFA need their normal interactive authentication flow.

```js
import { createMcpClient } from './src/mcp.mjs';

const connection = await playground.getMcpConnection();
const client = createMcpClient({
  request: playground.request.bind(playground),
  token: connection.token,
});
try {
  await client.initialize();
  const catalogue = await client.request('tools/list');
  // Use the discovered schemas; keep the token private to this client.
} finally {
  await client.close();
}
```

Deployment verification uses the real HTTP endpoint for initialization, tool discovery and an action-description call. The integration test also checks invalid-token rejection. These operations verify authenticated transport and the installed catalogue. **MCP content editing is not available in this release.** Actions which call Joomla's API again require nested same-site PHP request execution; the runtime rejects those requests promptly instead of waiting on its own occupied queue. The browser check verifies that a rejected action leaves MCP and Joomla usable. External clients cannot reach a private browser instance through the static hosting URL. Native console processes and stdio are outside this browser integration.

`test/deploy-packages.integration.mjs` covers real installation, administrator rendering, Sodium operation, authenticated MCP HTTP initialization/discovery, and rejection of invalid API credentials and an incorrect administrator password. The component's GNU GPL notices remain in the unchanged installed package.
