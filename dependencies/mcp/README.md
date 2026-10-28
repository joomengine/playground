# JoomEngine MCP in a browser deployment

The `jcb-mcp` deploy installs the pinned [JoomEngine MCP package](https://github.com/joomengine/mcp_package/tree/v1.0.10) alongside JCB on Joomla 6. Joomla 5 selects the JCB-only deploy. The source archive and SHA-256 are recorded in `deploys/jcb-mcp.json`; the package supplies its component, console plugin and webservices plugin unchanged.

PHP loads the real Sodium extension required by the package. After a fresh installation, Rocket runs a private diagnostic with the generated administrator's credentials. It authenticates through Joomla's administrator login, verifies the component and primitive ACL requirements, and calls the installed component's `SystemInfoAction` and `ListExtensionsAction` through `NativeFactory`. The latter reads installed components through Joomla's actual Installer Manage model. No HTTP request to the same PHP worker is needed.

The diagnostic is a fixed, read-only deployment operation. It does not expose an MCP server, accept arbitrary handlers or arguments, create API tokens, impersonate a console principal, or relax the component's `PHP_SAPI` checks. Accounts requiring interactive MFA cannot use this noninteractive diagnostic. Saved sites are not automatically probed again after their owner changes authentication policy.

The standard API transport performs downstream HTTP requests, while its stdio transport and asynchronous/JCB workers require a native CLI process. Those transports and process jobs are not available through this diagnostic. Browser-local native read verification must not be presented as an externally reachable MCP endpoint or proof that every MCP tool can run in WebAssembly.

`test/deploy-packages.integration.mjs` covers real installation, administrator rendering, Sodium operation, both native reads, and rejection of an incorrect administrator password. The component's GNU GPL notices remain in the unchanged installed package.
