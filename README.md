# JoomEngine Playground

Run Joomla in your browser with Sean Morris’s PHP WebAssembly runtime and a real
MariaDB WebAssembly database. The playground assembles published upstream PHP
packages, the MariaDB bridge, and a separately compiled native PDO extension into
a static site. PHP requests and SQL execute in browser workers.

## Upstream foundations and credits

This project builds directly on the work of these maintainers and contributors:

- **[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm)** — Sean Morris
  and the project’s contributors provide the PHP runtime, CGI implementation,
  filesystem, asynchronous JavaScript integration, and loadable extension
  support. The playground consumes their published runtime and extension
  packages directly.
- **[emscripten-core/emscripten](https://github.com/emscripten-core/emscripten)** —
  The Emscripten maintainers and contributors provide the compiler toolchain and
  runtime facilities that make PHP, native extensions, and MariaDB available in
  WebAssembly.
- **[JoomEngine MariaDB WASM Bridge](https://github.com/joomengine/mariadb-wasm-bridge)**
  provides the database worker, persistence, host protocol, native PDO driver,
  and adapter for the upstream PHP runtime.
- **[shyim/lite4mariadb](https://github.com/shyim/lite4mariadb)** and
  **[MariaDB](https://github.com/MariaDB/server)** provide the actual database
  engine used by the bridge.
- **[Joomla](https://github.com/joomla/joomla-cms)** provides the CMS and its
  installation, extension management, and console interfaces.

Thank you to these communities for the engineering and maintenance this project
relies on. Their licenses and notices remain with the distributed assets; see
[NOTICE](NOTICE).

## What is assembled

The browser loads `php-cgi-wasm` and its published extension packages. A small
`pdo_mariadb_wasm` module registers PDO’s `mysql` driver. Its asynchronous adapter
passes database operations to the MariaDB bridge. The playground service worker
routes site requests to a dedicated PHP worker and adds the isolation headers
needed by the threaded MariaDB engine.

The native build compiles only the PDO extension against matching PHP headers.
It does not rebuild PHP or maintain another PHP runtime. The distributed `.so`
files are WebAssembly extensions for these specific upstream builds, not native
Linux PHP modules.

The current pinned catalog is:

| Joomla distribution | Available PHP builds |
| --- | --- |
| 5.4.10 | 8.3.11, 8.4.1, 8.5.2 |
| 6.2.0 | 8.3.11, 8.4.1, 8.5.2 |

These are the patch versions contained in the selected upstream `0.2.0`
packages. They are recorded explicitly for ABI compatibility; the minor-version
selector does not imply a newer PHP patch release. Defaults are Joomla 6.2.0 and
PHP 8.4.1. [versions.json](versions.json) is the authoritative build catalog.

## Build and run locally

Use Node.js 24.5 or newer, npm, Git, Python 3, Bash, curl, tar, Make, and the
Emscripten toolchain pinned in `versions.json`. On Ubuntu, install the native
header-configuration prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y build-essential autoconf automake bison re2c libtool pkg-config curl git python3 xz-utils
```

Clone the playground, install its locked packages, and check out the exact bridge
and Emscripten SDK revisions selected by the catalog:

```bash
git clone https://github.com/joomengine/playground.git
cd playground
npm ci --ignore-scripts

mkdir -p external
git clone https://github.com/joomengine/mariadb-wasm-bridge.git external/bridge
bridge_ref=$(node --input-type=module -e "import p from './versions.json' with {type:'json'}; console.log(p.nativeDriver.sourceCommit)")
git -C external/bridge checkout --detach "$bridge_ref"

git clone https://github.com/emscripten-core/emsdk.git external/emsdk
emsdk_ref=$(node --input-type=module -e "import p from './versions.json' with {type:'json'}; console.log(p.upstream.emsdkCommit)")
git -C external/emsdk checkout --detach "$emsdk_ref"
compiler_version=$(node --input-type=module -e "import p from './versions.json' with {type:'json'}; console.log(p.upstream.emscripten)")
external/emsdk/emsdk install "$compiler_version"
external/emsdk/emsdk activate "$compiler_version"
source external/emsdk/emsdk_env.sh

while IFS= read -r minor; do
  bash external/bridge/native/build-upstream.sh "$minor" "$PWD/.cache/native"
done < <(node --input-type=module -e "import p from './versions.json' with {type:'json'}; for (const v of p.php) console.log(v.version)")

BRIDGE_SOURCE_DIR=external/bridge MARIADB_DRIVER_DIR=.cache/native npm run build
npm run serve
```

Open <http://127.0.0.1:4173/>. The local server serves static files and supplies
COOP/COEP headers. `PORT` and `HOST` can override its listen address. Build outputs
are written to `dist/`; source downloads and compiled modules are cached under
`.cache/` and the bridge’s `.native-build/` directory.

If the bridge is checked out next to the playground, the build also supports its
default paths: `../mariadb-wasm-bridge` for adapter sources and
`../mariadb-wasm-bridge/.native-build/upstream` for compiled extensions.

## Build provenance

`package-lock.json` pins the npm packages and their integrity values.
`versions.json` pins upstream source revisions, PHP source checksums, the MariaDB
release archive checksum, native and adapter source hashes, Joomla distributions,
and compatible runtime combinations.

The build verifies every entry in the MariaDB release inventory and retains its
prepared database engine. It then stages the bridge JavaScript runtime and PHP
adapter from the pinned bridge source revision, checking every source hash. The
PDO extension’s compiler, PHP version, source hashes, upstream revision, and
binary hash must also match. Each Joomla archive is verified before staging. A
missing driver or mismatched input fails the build.

`dist/assets/manifest.json` records the selected runtimes, extension assets,
preload files, source revisions, and dependency identities. Its `bridge.release`
entry identifies the original release archive; `bridge.overlay` identifies the
effective JavaScript and adapter sources. The original archive inventory is
retained as `assets/mariadb/release-manifest.json` and describes that release,
rather than the assembled bridge directory.
`dist/asset-inventory.json` records the files, sizes, and SHA-256 values in the
assembled site. Updating a dependency means updating its pins, rebuilding its
matching native modules, and running the complete validation suite.

## Using the playground

Select a Joomla release and PHP version, set the administrator credentials, and
launch. The interface generates a random administrator password initially; use
its password control to retain that value if you need to log in manually later.
The setup creates a real Joomla installation and can sign in through Joomla’s
normal administrator login form.

Persistence is enabled by default. Joomla files, session data, cookies, and the
MariaDB database are kept in IndexedDB. A site key identifies saved data within
this playground’s URL. Use different keys for independent sites or Joomla
versions. A saved site cannot be opened concurrently in another tab.

- **Save** flushes PHP files and database changes to browser storage.
- **Restart** reopens the saved site. Restarting a temporary site creates a fresh
  installation.
- **Close** shuts down the workers and releases the site lock.
- **Reset** deletes that site’s saved files and database after confirmation.

Administrator settings, extension installation, and startup commands apply when
a site is first installed. Reopening a completed installation keeps its existing
configuration. Changing its Joomla release requires a different site key or a
reset. Browser storage can be evicted or cleared and is not a backup; unloading
a tab cannot guarantee completion of an outstanding save.

The initial page accepts a path within the site, such as `/` or
`/administrator/`. The extension settings accept a JSON array of objects with a
`url` and an optional `sha256` field. URLs must use HTTPS, except localhost HTTP
for development. The hosting server must allow browser access through CORS when
it is on another origin. Packages are ZIP archives, limited to 128 MiB; supplied
SHA-256 values are checked before Joomla installs them. The interface keeps
separate extension selections while switching between Joomla releases.

Startup commands are JSON arrays of Joomla console argument arrays. They run in
order after extension installation, without a shell. For example:

```json
[["cache:clean"]]
```

Use command names and arguments directly; do not prepend `php`, a script path,
or shell operators. A failed extension installation or command stops setup and
reports the failure. An interrupted installation must be reset before retrying.

## Embedding and URL configuration

The interface recognizes these query parameters:

| Parameter | Meaning |
| --- | --- |
| `joomla=6.2.0` | Select the exact Joomla catalog entry |
| `php=8.4` | Select the PHP minor whose patch version is pinned in the catalog |
| `path=/administrator/` | Initial page inside Joomla |
| `toolbar=0` | Hide the configuration toolbar |
| `persist=0` | Use a temporary site |
| `start=1` | Launch automatically after environment preparation |

For a deployment hosted at `/playground/`, this same-origin iframe opens an
administrator playground with the toolbar hidden:

```html
<iframe
  src="/playground/?joomla=6.2.0&php=8.4&path=%2Fadministrator%2F&toolbar=0&start=1"
  title="Joomla Playground"
  allow="cross-origin-isolated"
  style="width:100%;height:800px;border:0"
></iframe>
```

The embedding page must also provide the isolation policy required by the
browser. The iframe permission alone cannot make an unisolated parent page
cross-origin isolated. Start with same-origin embedding and matching COOP/COEP
headers. A copied site-preview URL requires its owning playground tab to remain
open; use the interface’s share URL to launch an independent session.

Share URLs contain public version and display settings only. They do not include
administrator credentials, extension packages, or startup commands, and they do
not transfer a saved site to another browser.

## JavaScript API

Import `src/playground.mjs` from the built deployment. Call
`prepareEnvironment()` before collecting settings: on a host without isolation
headers, its first invocation can require one page reload after the service
worker takes control. The supplied interface performs that reload automatically.

The following complete module can be placed in a module script on a page at the
root of the built deployment. It starts a temporary Joomla site, displays the
administrator password, executes a PHP database query, and provides a close
button:

```js
import { createPlayground, prepareEnvironment } from './src/playground.mjs';

const output = document.createElement('pre');
const frame = document.createElement('iframe');
const closeButton = document.createElement('button');
closeButton.textContent = 'Close playground';
closeButton.disabled = true;
frame.title = 'Joomla';
frame.style.cssText = 'width:100%;height:700px;border:0';
document.body.append(output, closeButton, frame);

try {
  const environment = await prepareEnvironment();
  if (environment.reloadRequired) {
    location.reload();
  } else {
    const password = `Jp!${crypto.randomUUID()}`;
    const site = await createPlayground({
      phpVersion: '8.4',
      joomlaVersion: '6.2.0',
      siteName: 'API demonstration',
      initialPath: '/administrator/',
      persistence: false,
      storageKey: 'api-demo',
      autoLogin: true,
      admin: {
        name: 'Playground Administrator',
        username: 'admin',
        email: 'admin@example.test',
        password,
      },
      extensions: [],
      startupCommands: [],
    }, {
      onProgress: ({ message }) => { output.textContent = message; },
    });
    frame.src = site.url;
    const result = await site.runPhp(`<?php
      $db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
      echo $db->query('SELECT VERSION()')->fetchColumn();
    `);
    output.textContent = `Administrator: admin\nPassword: ${password}\nMariaDB: ${result.text}`;
    closeButton.disabled = false;
    closeButton.addEventListener('click', async () => {
      closeButton.disabled = true;
      try {
        await site.close();
        frame.remove();
        output.textContent = 'Playground closed.';
      } catch (error) { output.textContent = error.message; }
    }, { once: true });
  }
} catch (error) {
  output.textContent = error.message;
}
```

`createPlayground(config, { onProgress })` returns a handle only after Joomla
provisioning completes:

| Handle member | Result |
| --- | --- |
| `url`, `baseUrl` | Initial page and site root URLs |
| `runtimeInfo` | Actual PHP version, loaded extensions, and PDO drivers |
| `installation` | Joomla version, site name, and whether saved data was reopened |
| `request(path, init)` | A standard `Response` for an internal site request |
| `runPhp(source, { timeoutMs })` | CGI result with `status`, `headers`, binary `body`, and decoded `text` |
| `fs.mkdir(path)` | Create directories in the virtual filesystem |
| `fs.writeFile(path, textOrBytes)` | Write a virtual file |
| `fs.readFile(path)` | Read bytes; pass `{ encoding: 'utf8' }` as the second argument for text |
| `fs.readdir(path)`, `fs.stat(path)`, `fs.unlink(path)` | Inspect or remove virtual files |
| `flush()` | Flush both stores |
| `close()` | Close the instance while keeping saved data |
| `reset()` | Close the instance and delete its saved data |

`resetPlayground({ storageKey })`, exported from the same module, erases a closed
or partially installed saved site. Call it only after the user confirms deletion.
The filesystem document root is `/persist/www`. `runPhp` executes through CGI;
it is not a shell or an unrestricted host command interface.

## Hosting and GitHub Pages

Serve the entire `dist/` directory over HTTPS, or use localhost for development.
Do not open `index.html` through `file://`. WebAssembly modules and other assets
must remain at their generated relative paths. Serve `.mjs` as JavaScript and
`.wasm`/`.so` as `application/wasm`.

A static host that supports response headers should supply:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

MariaDB requires `SharedArrayBuffer`, a secure context, and cross-origin
isolation. The playground also requires service workers, IndexedDB, and Web
Locks. GitHub Pages cannot configure these response headers directly, so the
included service worker adds them to controlled responses and the interface
reloads once to activate isolation. That worker also handles the PHP site routes;
do not replace it with an unrelated isolation worker.

The **Publish playground to Pages** workflow is manual and accepts only `main`.
It runs validation first and deploys the resulting artifact through the
`github-pages` environment. Configure the repository’s Pages source as GitHub
Actions and apply any required environment approvals before running it.

## Validation

Run source checks and helper tests after installing dependencies:

```bash
npm run check
npm test
```

After compiling the drivers, validate native PDO against the real upstream PHP
and MariaDB packages:

```bash
(cd external/bridge && npm ci --ignore-scripts && npm run prepare:engine)
PHP_WASM_MODULE_ROOT="$PWD/node_modules" \
PHP_WASM_EXTENSION_DIR="$PWD/.cache/native" \
node --test external/bridge/native/tests/upstream.test.mjs
```

Build the static site, install the browser engines, and run browser integration:

```bash
BRIDGE_SOURCE_DIR=external/bridge MARIADB_DRIVER_DIR=.cache/native npm run build
npx playwright install --with-deps chromium firefox
npm run test:browser
```

The browser suite uses real PHP, native PDO, MariaDB, and Joomla. It exercises
catalog combinations, installation, administrator access, persistence, extension
installation, startup commands, timeout recovery, and the service-worker hosting
path. `PLAYGROUND_BROWSERS`, `PLAYGROUND_PHP_VERSIONS`, and
`PLAYGROUND_JOOMLA_VERSIONS` can narrow local investigations. CI runs the complete
catalog and retains the tested distribution and browser diagnostics.

## Scope and limitations

This is a browser-local environment for trusted development and demonstrations.
Installed extensions and PHP code run with access to that playground’s files and
database. Keep independent applications in separate site keys; this is not a
multi-tenant hosting boundary.

The bridge exposes one native connection per MariaDB instance, uses PDO emulated
prepares, and does not implement `mysqli` or remote database connections. Integer
values within PHP’s integer range are returned as integers; larger integers and
DECIMAL values remain exact strings. `PDO::ATTR_STRINGIFY_FETCHES` requests
numeric strings explicitly. Files and database state are separate stores; they
are not committed together as one transaction.

The selected upstream CGI release accepts request bodies for POST. The playground
rejects bodies on other HTTP methods instead of discarding them. Request queues,
source size, body size, and execution time are bounded. On timeout, PHP is
terminated and the database lease is reset; uncertain writes are never replayed.
Restart the instance before continuing after a runtime failure.

Host processes, system executables, arbitrary socket services, and a production
mail server are not supplied by this static playground. Extensions that require
those facilities need a different environment. JCB can be supplied through the
extension configuration; a complete JCB compilation workload requires its own
application-level validation.
