# JoomEngine Playground

Run Joomla in your browser with Sean Morris’s PHP WebAssembly runtime and a real
MariaDB WebAssembly database. The playground assembles published upstream PHP
packages, the MariaDB bridge, and a separately compiled native PDO extension into
a static site. PHP requests and SQL execute in browser workers.

The deployment address is **https://playground.joomengine.org/**. The default
deploy installs **JCB + MCP on Joomla 6** and **JCB only on Joomla 5**. Select
**Joomla only** to start without additional extensions. Rocket is the compact,
multilingual interface around the running Joomla site.

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

Reference: [Official Joomla playground](https://github.com/joomla-projects/joomla-playground/).

## What is assembled

The browser loads `php-cgi-wasm` and its published extension packages. A small
`pdo_mariadb_wasm` module registers PDO’s `mysql` driver. Its asynchronous adapter
passes database operations to the MariaDB bridge. The playground service worker
routes site requests to a dedicated PHP worker and adds the isolation headers
needed by the threaded MariaDB engine.

The native build compiles the PDO, fileinfo, cURL, and Sodium extensions against
matching PHP headers. Fileinfo supplies MIME detection with its embedded magic
database.
cURL uses Sean Morris’s [php-wasm-curl](https://github.com/seanmorris/php-wasm-curl)
to connect PHP’s unchanged `ext/curl` to the host’s Fetch API. The implementation
is pinned to [6085917954da9682c32ebcbea27a626d2308381b](https://github.com/seanmorris/php-wasm-curl/tree/6085917954da9682c32ebcbea27a626d2308381b)
and loaded alongside the published `0.2.0` PHP runtime. Sodium uses the official
libsodium 1.0.22 release and Web Crypto for its random source. A checksum-verified
JavaScript CGI input adapter preserves binary request bodies and uses indexed
input reads for large uploads; the upstream PHP WebAssembly binary is unchanged.
The distributed `.so`
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

Use Node.js 26.12.1 as pinned in [.node-version](.node-version), npm, Git, Python 3,
Bash, curl, tar, Make, and the Emscripten toolchain pinned in `versions.json`.
This is the tested build runtime; Node.js 24.x has a known
[V8 shared-WASM lifecycle crash](https://github.com/nodejs/node/issues/66366).
On Ubuntu, install the native
header-configuration prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y build-essential autoconf automake bison re2c libtool pkg-config curl git python3 xz-utils php8.3-cli php8.3-mbstring php8.3-xml php8.3-gd php8.3-zip php8.3-curl
```

Native PHP composes the [locked JCB spreadsheet dependencies](dependencies/jcb-spreadsheet/README.md)
for the browser's 32-bit PHP platform. The build downloads and verifies its pinned
Composer binary. `PHP_BINARY` can select a native PHP executable; the browser
continues to use the upstream WebAssembly runtime.

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
  BRIDGE_SOURCE_DIR=external/bridge node scripts/build-fileinfo.mjs "$minor"
  BRIDGE_SOURCE_DIR=external/bridge node scripts/build-curl.mjs "$minor"
  BRIDGE_SOURCE_DIR=external/bridge node scripts/build-sodium.mjs "$minor"
done < <(node --input-type=module -e "import p from './versions.json' with {type:'json'}; for (const v of p.php) console.log(v.version)")

BRIDGE_SOURCE_DIR=external/bridge MARIADB_DRIVER_DIR=.cache/native npm run build
npm run build:deploys
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

The build verifies every entry in the MariaDB bridge 0.1.3 release inventory and
retains its engine WebAssembly binary unchanged. It stages the bridge runtime,
PHP adapter and generated engine JavaScript glue from the pinned source revision
`090c29d2b25dcd216941cfbeaf17b847d6f3658a`, checking their source and generated hashes.
The overlay records the browser CPU scheduling budget and UTF-8 charset handling
separately from the immutable release archive. The
PDO extension’s compiler, PHP version, source hashes, upstream revision, and
binary hash must also match. Native fileinfo, cURL and Sodium modules retain
their matching source inventories, compiler identities and licenses. The CGI
JavaScript adapter records original and adjusted hashes. Each Joomla archive is
verified before staging. A missing driver or mismatched input fails the build.

`dist/assets/manifest.json` records the selected runtimes, extension assets,
preload files, source revisions, and dependency identities. Its `bridge.release`
entry identifies the original release archive; `bridge.overlay` identifies the
effective JavaScript runtime, adapter and engine-glue sources. The original archive inventory is
retained as `assets/mariadb/release-manifest.json` and describes that release,
rather than the assembled bridge directory.
`dist/asset-inventory.json` records the files, sizes, and SHA-256 values in the
assembled site. Updating a dependency means updating its pins, rebuilding its
matching native modules, and running the complete validation suite.

## PHP HTTP requests

PHP’s `curl_*` functions and HTTP stream wrappers perform real HTTP requests
through the upstream Fetch integration. cURL supports request methods, headers,
binary bodies, status codes, redirects, timeouts, and streaming response
callbacks. The native extension is exercised on every supported PHP build,
including the HTTP patterns used by JCB’s file and API helpers.

In a browser, remote servers must permit the playground origin through CORS.
Only HTTP and HTTPS are supported. The browser controls certificate validation,
cookies, forbidden request headers, and connection behavior; options for disabling
TLS verification cannot bypass browser security. Redirect responses are hidden
from browser Fetch: enable following explicitly when a client needs redirects.
PHP’s cookie-file settings do not create a separate browser cookie store.
HTTP proxies and Unix sockets are unsupported. Requests to PHP in the same
playground instance cannot complete recursively while its worker is already
executing a request; use a separate server or independent instance for HTTP
service calls. See
the [upstream compatibility guide](https://github.com/seanmorris/php-wasm/blob/6e206f8c053f74f209a10d99fab0a7fa74b01ee5/packages/curl/README.md#differences-from-native-curl)
before relying on server-specific networking behavior. The playground does not
provide a public CORS proxy.

## Using Rocket

The default page automatically launches the selected deploy. Use `?start=0` to
configure it first. The slim header scrolls away with the page; its expandable
controls and dialogs leave the Joomla site the full available width. The launch
view shows the rocket animation and deployment progress. Activity remains
available below the site, and the footer information button lists dependency
credits and licenses.

The deployment editor selects Joomla, PHP, packages, languages, the site name,
login behavior, menus and a template. It can install a component from a public
ZIP URL, make one of its frontend views the Home menu item, install a template,
and set its parameters. Installed components, menu layouts and template styles
can be discovered from the running site. See the [deploy guide](deploys/README.md)
for the complete document format and advanced parameters.

- **Use** starts an independent deployment from the editor's configuration and
  prepares a reusable share link.
- **Apply to this site** checkpoints the running site before installing new
  packages or applying configuration. If an operation fails, the recovery action
  restores that checkpoint as a separate site. Removing a package from the editor
  does not uninstall an already installed extension.
- **Keep my site / Save** saves both files and database. Keeping a temporary site
  copies its current state into persistent storage, including its credentials.
- **Restart** restarts PHP with the current settings while preserving the site,
  including a temporary site's files and database.
- **Close** shuts down the workers and releases the site lock. Closing a temporary
  site discards its state after confirmation.
- **Reset** deletes the selected site's saved data after confirmation.
- **New site** starts an independent installation; saved sites remain selectable.
- **Download** exports the complete site, its files, or its SQL database.
- **Open site** transfers the running site to a standalone tab without Rocket's
  header and footer. The original tab releases ownership; after transfer the new
  tab runs independently.

Persistence is enabled by default. Joomla files, session data, cookies and the
MariaDB database are kept in IndexedDB. A site key identifies saved data on this
origin. Returning to the domain reopens the last saved site; the saved-site
selector opens others. Only one tab may own a saved site at a time. Changing PHP
preserves its content. Changing the Joomla release or selecting another deploy
starts a separate profile instead of upgrading an existing Joomla installation.

The credentials dialog shows the generated administrator login details, including
when automatic login is disabled. Each fresh site receives new credentials;
saved sites retain theirs. Credentials stay in private runtime metadata outside
the webroot, exports, share links and browser preferences. Browser storage can be
evicted or cleared and is not a backup. A save reports completion only after both
stores flush; closing a tab cannot guarantee an unfinished save completes.

External extension and template packages must be ZIP archives served over HTTPS
(localhost HTTP is allowed for development). Cross-origin hosts must permit
browser access through CORS. Packages are limited to 128 MiB. An optional SHA-256
is verified before installation; repository packages always have pinned digests.
When a host blocks downloads, provide a permitted URL or stage the package on the
playground origin. There is no public download proxy.

Startup commands are arrays of Joomla console arguments, executed in order after
package installation and without a shell. For example:

```json
[["cache:clean"]]
```

Use command names and arguments directly, without `php`, a script path or shell
operators. A failed installation or command stops setup and reports its details.
An interrupted initial installation must be reset before retrying. Reopening a
completed site does not replay its original deployment commands.

A complete export contains `site/`, `database.sql`, `database.ndjson` for
prepared-site import, `export.json`, and `DEPLOYMENT.md`. Its Joomla configuration
uses portable paths and placeholder hosting database settings. Follow the
included instructions to upload files, import SQL, and configure the destination
database. Private runtime metadata, browser sessions, and generated caches are
excluded. Files-only ZIP and SQL-only downloads are also available. Tables,
views, and simple triggers are supported. Stored routines, events, compound
trigger bodies, system-versioned tables, cross-database references, and aliases
or common table expressions matching the source database name stop export with
an explicit error.

## Interface and Joomla languages

Rocket starts in English. Its independent language selector offers English,
Afrikaans, German, French, Italian, Spanish, Simplified Chinese, Dutch, Hebrew,
Greek, Arabic, Portuguese, Russian, Japanese, Korean, Hindi, Bengali, Turkish,
Indonesian and Ukrainian. Hebrew and Arabic use a right-to-left interface.
Translated interface catalogs load on selection. The preference is saved locally;
`?uiLanguage=af` selects Afrikaans explicitly. This changes Rocket's controls,
dialogs and footer, without changing Joomla or downloading a Joomla language pack.
Technical details from PHP, Joomla and installed extensions retain their original
messages in the activity log.

Ordinary Joomla deployments use Joomla's English default. The multilingual
heritage deploy installs **Afrikaans, German, French, Italian, Spanish, Simplified
Chinese, Dutch and English**, with **Afrikaans first and default**. Selecting a
multilingual deployment enables the corresponding content languages, language
filtering, switcher and language-specific home pages.

Language packs are separate installable ZIPs fetched only for the selected Joomla
languages; an English-only site downloads none. The build assembles deterministic
packages from pinned official Joomla translation sources and serves verified ZIPs
on the playground origin when direct package-host CORS would block browser
installation. Translations are not embedded in PHP or eagerly preloaded. Exact
source revisions, file hashes and license details are documented in
[the language package notes](dependencies/joomla-languages/README.md).

## PHP configuration and capabilities

The **PHP settings** dialog changes the running PHP configuration and restarts its
worker while preserving files and database. It verifies the effective values
reported by PHP and attempts to restore the previous configuration if startup
fails. The same `phpSettings` object works in deployment documents and repository
deploys:

```json
{
  "upload_max_filesize": "128M",
  "post_max_size": "160M",
  "max_execution_time": 60,
  "max_input_time": 60,
  "max_input_vars": 10000,
  "memory_limit": "512M"
}
```

These defaults cover JCB's published guidelines with extra POST, form-variable
and memory headroom. POST size must exceed the upload limit, and PHP memory must
leave at least 64 MiB above POST size. The editor validates bounded values rather
than accepting arbitrary ini directives. Deploys can request different values;
Service Directory allows 180 seconds for its large initial geographic-data import.
A PHP memory limit is not a guarantee that a particular browser or device can
allocate that much memory.

Runtime health checks require the real PDO MySQL bridge, cURL, fileinfo, Sodium,
GD, Intl, mbstring, OpenSSL, DOM, SimpleXML, XML/reader/writer, JSON, ZIP and zlib
extensions. Provisioning checks exercise image decoding, Unicode/XML, archives,
cryptography, database access and uploads. GD supports JPEG, PNG and WebP; AVIF
and XPM are not built into this runtime. The [official Joomla Docker image](https://github.com/joomla/docker-joomla)
is a setup reference, while browser limitations remain explicit below.

The Joomla 6 **JCB + MCP** deploy installs the real MCP package and verifies
Sodium, administrator authentication/ACL, system information and installed
extension reads through its native Joomla integration. This read-only diagnostic
does not expose an external MCP endpoint or provide a native CLI process. Its
stdio transport and process-based jobs remain unavailable in a static browser
runtime; see [the MCP integration notes](dependencies/mcp/README.md).

## Embedding and URL configuration

Repository deploys define packages, language packs, content, and console
commands. See the [contributor guide and schemas](deploys/README.md) to add
another recipe. The default is `jcb-mcp` on Joomla 6 and `jcb` on Joomla 5;
`blank` installs Joomla alone. Deployment documents can also be composed entirely
in the interface without changing this repository.

- [JCB + MCP — Joomla 6](https://playground.joomengine.org/?deploy=jcb-mcp)
- [JCB only — Joomla 5 or 6](https://playground.joomengine.org/?deploy=jcb)
- [Service Directory — Joomla 5 or 6](https://playground.joomengine.org/?deploy=servicedirectory)
- [Joomla only](https://playground.joomengine.org/?deploy=blank)
- [Multilingual heritage site](https://playground.joomengine.org/?deploy=heritage-demo)
- [Heritage built from its recipe](https://playground.joomengine.org/?deploy=heritage-demo&fresh=1)
- [Patch Tester](https://playground.joomengine.org/?deploy=patchtester)
- [Weblinks](https://playground.joomengine.org/?deploy=weblinks)
- [Joomla 5.4](https://playground.joomengine.org/?joomla=5.4)
- [PHP 8.5](https://playground.joomengine.org/?php=8.5)
- [Start logged out](https://playground.joomengine.org/?login=no)

`fresh=1` creates an independent site key and bypasses prepared snapshots. It
does not erase another saved site. The flag is consumed after launch and the new
key stays in the address for subsequent reloads. Use Reset to erase the current
site explicitly.

The build stages verified packages on the same origin. For `prebuild: true`
recipes, `npm run build:deploys` installs real Joomla, exports it, and imports
the archive into a second runtime with new credentials before publishing it.
Prepared copies match an exact Joomla release. The heritage demonstration is
prepared for both catalog releases; `fresh=1` builds its original recipe instead.

The interface recognizes these query parameters:

| Parameter | Meaning |
| --- | --- |
| `deploy=jcb-mcp` | Choose a repository deploy; `blank` installs Joomla alone |
| `joomla=5.4` | Resolve a minor or exact version to a tested catalog release |
| `php=8.4` | Select the PHP minor whose patch version is pinned in the catalog |
| `path=/administrator/` | Initial page inside Joomla |
| `toolbar=0` | Hide the configuration toolbar |
| `persist=0` | Use a temporary site |
| `language=en-GB` | Select the Joomla language; another supported tag installs its pack |
| `uiLanguage=af` | Select Rocket's interface language independently |
| `name=Client%20demo` | Set the Joomla site name |
| `login=no` | Start or reopen with the administrator logged out |
| `fresh=1` | Create an independent site from the recipe |
| `key=example` | Reopen a saved site in this browser |
| `extensions=[...]` | Additional objects containing `url` and optional `sha256` |
| `commands=[["cache:clean"]]` | Additional Joomla console argument arrays |
| `start=0` | Show setup first; the default page starts automatically |
| `config=https://example.org/deploy.json` | Load a public deployment document, optionally verified with `sha256` |

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
headers. A raw site-preview URL still requires its owning playground tab. Use
**Open site** to transfer ownership to a standalone tab, or **Share** to launch an
independent installation from the same public deployment configuration.

Share includes the complete public deployment: Joomla/PHP versions, PHP settings,
site name, packages, language selections, menus, template parameters, login choice
and setup commands. Advanced configurations use an encoded `#deploy=` fragment.
The Share dialog always exposes the link for manual copying if clipboard access
is unavailable. It can download/import deployment JSON or generate a link to a
hosted configuration. Links are limited to 16 KiB; JSON documents to 1 MiB.

Public deployment documents never contain administrator credentials or local
site keys and do not transfer saved files or database content. Known credential
fields and secret-bearing URL parameters are rejected. Review package locations
and command arguments before sharing. Use a complete site download to transfer
site content. The [document schema](deploys/document.schema.json) and
[deploy guide](deploys/README.md#compose-a-deployment-without-a-repository-change)
describe the JSON format, menu/template fields and hosted configuration URLs.

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
| `runtimeInfo` | Actual PHP version, loaded extensions, PDO drivers and effective ini settings |
| `configuration` | A copy of the resolved current configuration |
| `installation` | Joomla version, site name, and whether saved data was reopened |
| `request(path, init)` | A standard `Response` for an internal site request |
| `runPhp(source, { timeoutMs })` | CGI result with `status`, `headers`, binary `body`, and decoded `text` |
| `fs.mkdir(path)` | Create directories in the virtual filesystem |
| `fs.writeFile(path, textOrBytes)` | Write a virtual file |
| `fs.readFile(path)` | Read bytes; pass `{ encoding: 'utf8' }` as the second argument for text |
| `fs.readdir(path)`, `fs.stat(path)`, `fs.unlink(path)` | Inspect or remove virtual files |
| `flush()` | Flush both stores |
| `keep()` | Persist a temporary site's current state; returns its replacement handle |
| `checkpoint()` | Create a private recovery snapshot, including administrator state |
| `updatePhpSettings(settings, phpMinor?)` | Restart PHP, validate effective values and preserve site data |
| `switchPhpVersion(phpMinor)` | Restart on another compatible pinned PHP build |
| `discoverConfiguration()` | Discover installed components, frontend layouts, menus and templates |
| `applyConfiguration(configuration)` | Apply additions and site settings with a recovery checkpoint |
| `openStandalone({ path })` | Transfer ownership to an independent tab; call from a user gesture |
| `exportSite({ format })` | Return `{ bytes, filename, mimeType, metadata }`; format is `bundle`, `files`, or `database` |
| `close()` | Close the instance while keeping saved data |
| `reset()` | Close the instance and delete its saved data |

`resetPlayground({ storageKey })`, exported from the same module, erases a closed
or partially installed saved site. Call it only after the user confirms deletion.
Private checkpoints include authentication state: keep them local and do not
use them as public deployment documents. The filesystem document root is
`/persist/www`. `runPhp` executes through CGI; it is not a shell or an unrestricted
host command interface.

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

The **Publish playground to Pages** workflow runs on every push or merge to
`main`, and can also be started manually on `main`. It validates first, then
deploys that exact tested artifact through the `github-pages` environment.
Failed validation prevents deployment.

Configure Pages with source **GitHub Actions** and custom domain
**playground.joomengine.org**. The committed `CNAME` is copied into the build.
Point the domain's DNS CNAME record to `joomengine.github.io`, then enable HTTPS
in Pages once GitHub has provisioned its certificate. Repository environment
approvals still apply.

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
node --test test/fileinfo.integration.mjs test/curl.integration.mjs test/sodium.integration.mjs
```

Build the static site, install the browser engines, and run browser integration:

```bash
BRIDGE_SOURCE_DIR=external/bridge MARIADB_DRIVER_DIR=.cache/native npm run build
npx playwright install --with-deps chromium firefox
npm run test:provisioning
npm run build:deploys
npm run test:browser
```

The browser suite uses real PHP, native PDO, MariaDB, and Joomla. It exercises
catalog combinations, administrator access, extension installation, configuration,
persistence, temporary-site retention, restart, PHP settings, exports, sharing,
standalone ownership transfer, responsive controls and timeout recovery.
`PLAYGROUND_BROWSERS`, `PLAYGROUND_PHP_VERSIONS`, `PLAYGROUND_JOOMLA_VERSIONS` and
`PLAYGROUND_SCENARIOS` narrow local investigations.

CI runs source checks and unit tests first. Documentation-only pull requests skip
native/browser jobs. Presentation-only changes run the default Joomla 6.2.0 / PHP
8.4 combination with deployment, lifecycle and Rocket checks. Runtime, deployment,
configuration and unclassified changes run the full supported matrix, as do
`main` and manual builds. Chromium and Firefox validate in parallel jobs against
the same built artifact. Native/compiler caches require exact source and toolchain
identities; downloads retain checksum validation. Provisioning uses bounded
concurrency and browser scenarios fail promptly. Pages publishes only the exact
artifact whose selected checks passed, and CI retains diagnostic output.

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

The verified JavaScript CGI input adapter supports binary POST, PUT, PATCH and
DELETE bodies, including large multipart uploads. Request queues, source size,
body size and execution time remain bounded. On timeout, PHP is terminated and the database lease is reset; uncertain writes are never replayed.
Restart the instance before continuing after a runtime failure.

Host processes, system executables, arbitrary socket services, and a production
mail server are not supplied by this static playground. Extensions that require
those facilities need a different environment. Installing an extension and passing
runtime health checks does not prove every workflow of every Joomla extension is
browser-compatible; exercise the particular component operations you plan to
demonstrate. Browser storage, WebAssembly memory and CORS still apply.
