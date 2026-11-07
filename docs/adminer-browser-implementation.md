# Adminer and browser isolation

Adminer runs against the active site's PHP and MariaDB instances. The DB action
loads the staged Adminer bundle on demand and uses the existing PHP request
queue, database credentials and stored data. It does not create another database.

Code and DB share the embedded workspace. Both support docked, floating,
full-width and detached layouts. Tool changes preserve the Joomla iframe,
authentication, editor buffers and database navigation. Detaching a tool must
not replay a database write.

Startup checks browser isolation and API availability before creating the
runtime. It prefers COEP credentialless and uses require-corp when required.
This state belongs to the top-level runtime owner and survives service-worker
restarts through the owner's URL metadata.

External HTTP requests use the common transport described in [network.md](network.md).
There is no Adminer-specific network service or approved-image registry.

The implementation is exercised by `test/adminer.test.mjs`,
`test/adminer.integration.mjs`, `test/adminer.browser.mjs` and the isolation
suites. See [database usage](database-user-guide.md) and
[browser compatibility](browser-compatibility.md).
