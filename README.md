# JoomEngine Playground

Build Joomla extensions with **Joomla Component Builder (JCB)** in your browser.
JCB is the development engine at the heart of JoomEngine. Sean Morris’s PHP
WebAssembly runtime and a real MariaDB WebAssembly database run the site. The
playground assembles published upstream PHP packages, the MariaDB bridge, and a separately compiled native PDO extension into
a static site. PHP requests and SQL execute in browser workers.

The deployment address is **https://playground.joomengine.org/**. The default
deploy opens the **JCB dashboard on Joomla 6 with PHP 8.4**. JCB is also the
default on Joomla 5; **JCB + MCP** remains an optional Joomla 6 deployment. Select
**Joomla only** to start without additional extensions. Rocket is the compact,
multilingual interface around the running Joomla site.

**JoomEngine Code** adds a lazy-loaded browser IDE for that same site: native
editor groups, project files and language services, docked/floating/detached
layouts, reviewed AI changes and PHP debugging of actual Joomla requests.
See the [user guide](docs/joomengine-code-user-guide.md), current
[experience roadmap](docs/roadmap/implementation-roadmap.md), and historical
[implementation checkpoints](docs/joomengine-code-checkpoints.md). Named AI API
presets, custom/local endpoints and scoped context are implemented; the
[AI validation record](docs/roadmap/ai-validation.md) distinguishes protocol tests
from outstanding real-service browser checks. Local editing and debugging do not
require AI credentials.

The **DB** action opens [Adminer](docs/database-user-guide.md) against the same
running database. Code and DB alternate in the embedded workspace, with separate
left/right/bottom, floating, full-width and detached layouts. Adminer loads on
demand and adds about 435 KiB of staged PHP/UI assets (about 246 KiB gzipped),
without another PHP or database engine.

[Browser compatibility](docs/browser-compatibility.md) verifies isolation before
starting the runtime and provides a controlled `require-corp` fallback. Its
restricted [public-image relay](relay/README.md) must be hosted and configured
before enabling fallback; the checked-in defaults preserve normal mode with no
relay dependency. Real mobile validation follows deployment.

For an agent-oriented introduction to configuring a site, working with JCB,
testing extensions and exporting results, see the [Playground agent guide](docs/agent-guide.md).

## Upstream foundations and credits

This project builds directly on the work of these maintainers and contributors:

- **[Joomla](https://github.com/joomla/joomla-cms)** provides the CMS and its
  installation, extension management, and console interfaces.
- **[Joomla Component Builder](https://github.com/joomengine/Joomla-Component-Builder)**
  is JoomEngine’s core development tool and default deployment.
- **[PHP/phpdbg](https://github.com/php/php-src)** supplies PHP and its debugger;
  JoomEngine Code uses Sean Morris's pinned `php-dbg-wasm` package with a small,
  reproducibly compiled HTTP/debugging bridge.
- **[MariaDB](https://github.com/MariaDB/server)** provides the database engine.
- **[seanmorris/php-wasm](https://github.com/seanmorris/php-wasm)** — Sean Morris
  and the project’s contributors provide the PHP runtime, CGI implementation,
  filesystem, asynchronous JavaScript integration, and loadable extension
  support. The playground consumes their published runtime and extension
  packages directly.
- **[JoomEngine MariaDB WASM Bridge](https://github.com/joomengine/mariadb-wasm-bridge)**
  provides the database worker, persistence, host protocol, native PDO driver,
  and adapter for the upstream PHP runtime.
- **[shyim/lite4mariadb](https://github.com/shyim/lite4mariadb)** makes the MariaDB
  engine available to the bridge as WebAssembly.
- **Microsoft [VS Code](https://github.com/microsoft/vscode) and
  [Monaco](https://github.com/microsoft/monaco-editor)** provide the editor and
  workbench foundations. **[CodinGame](https://github.com/CodinGame/monaco-vscode-api)**
  provides their browser integration. JoomEngine Code retains the exact shipped
  licenses, source notices and dependency inventory.
- **[Adminer](https://github.com/vrana/adminer)** provides the database interface
  for browsing tables, inspecting schemas and running SQL through the active
  site's existing PHP and MariaDB runtimes.
- **[emscripten-core/emscripten](https://github.com/emscripten-core/emscripten)** —
  The Emscripten maintainers and contributors provide the compiler toolchain and
  runtime facilities that make PHP, native extensions, and MariaDB available in
  WebAssembly.

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

The native build compiles the PDO, fileinfo, cURL, Sodium and phpdbg HTTP/debugging
bridges against matching PHP headers. Fileinfo supplies MIME detection with its embedded magic
database.
cURL uses Sean Morris’s [php-wasm-curl](https://github.com/seanmorris/php-wasm-curl)
to connect PHP’s `ext/curl` to the host’s Fetch API. The implementation
is pinned to [6085917954da9682c32ebcbea27a626d2308381b](https://github.com/seanmorris/php-wasm-curl/tree/6085917954da9682c32ebcbea27a626d2308381b)
and loaded alongside the published `0.2.0` PHP runtime. Sodium uses the official
libsodium 1.0.22 release and Web Crypto for its random source. A checksum-verified
JavaScript CGI adapter preserves binary request bodies, uses indexed input reads
for large uploads, and waits for preloaded files before starting or restoring PHP.
The upstream PHP WebAssembly binary is unchanged.
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
selector does not imply a newer PHP patch release. The pinned baseline is Joomla
6.2.0 and PHP 8.4.1. PHP 8.5 remains selectable, and existing saved sites retain
their selected runtime. [versions.json](versions.json) is the authoritative runtime
build catalog; the published version catalog adds current and forward packages.

## Current and forward version selection

Choose Joomla, JCB and PHP, then launch. The selected Joomla and JCB packages are
fetched automatically from the Playground's own static assets and installed inside
the browser. Choosing a version records the choice; it does not open a ZIP download
or upload dialog. Custom extension URLs remain subject to their host's browser
access rules.

The selectors show **Current stable** first, **Nightly builds** next and
**Upcoming releases** last. Joomla choices cover majors 5, 6 and 7: one latest
stable per major, the current nightly for each active development line, and the
newest alpha, beta or RC for each future release. Joomla 4 and historical releases
are excluded. JCB uses the same current-and-forward policy for major 5 onwards and
follows the selected Joomla major. Joomla 7 can use JCB 6 for forward testing while
JCB 7 is unavailable; this pairing is experimental. A previously selected archive
that falls outside the current list appears separately as **Saved version**.
Reopening it preserves the installed site rather than upgrading it.

At build time, discovery follows Joomla's official
[next patch](https://update.joomla.org/core/nightlies/next_patch_list.xml),
[next minor](https://update.joomla.org/core/nightlies/next_minor_list.xml) and
[next major](https://update.joomla.org/core/nightlies/next_major_list.xml) XML lists
to their details feeds and selects **Full Package** ZIPs for fresh installations.
JCB discovery reads only its
[5.x](https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/refs/heads/5.x/componentbuilder_update_server.xml)
and
[6.x](https://raw.githubusercontent.com/joomengine/Joomla-Component-Builder/refs/heads/6.x/componentbuilder_update_server.xml)
XML manifests. One recent Joomla release request, limited to 100 records, supplies
stable and published preview releases missing from the nightly feeds. Discovery
does not enumerate JCB branches or tags or paginate through old releases.

The build verifies published SHA-256/SHA-512 checksums, fingerprints full packages
without a published checksum, and writes immutable package paths alongside
`dist/assets/version-catalog.json`. Its `generatedAt` field identifies when the
catalog was built. The selectors refresh that published local catalog; they do not
query upstream servers or fetch a newer nightly on their own. Pages rebuilds daily
at 03:15 UTC and on changes to `main`, then publishes only after validation of that
same artifact. A failed upstream refresh or validation leaves the previous deployed
catalog and packages available. Use a new site to try a newly published nightly;
retain a complete site export when the exact old build must remain portable.

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

npm ci --prefix external/bridge --ignore-scripts
node scripts/prepare-bridge-engine.mjs external/bridge
npm run prepare:engine --prefix external/bridge

while IFS= read -r minor; do
  bash external/bridge/native/build-upstream.sh "$minor" "$PWD/.cache/native"
  BRIDGE_SOURCE_DIR=external/bridge node scripts/build-fileinfo.mjs "$minor"
  BRIDGE_SOURCE_DIR=external/bridge node scripts/build-curl.mjs "$minor"
  BRIDGE_SOURCE_DIR=external/bridge node scripts/build-sodium.mjs "$minor"
  BRIDGE_SOURCE_DIR=external/bridge node scripts/phpdbg-build.mjs "$minor"
done < <(node --input-type=module -e "import p from './versions.json' with {type:'json'}; for (const v of p.php) console.log(v.version)")

MARIADB_DRIVER_DIR=.cache/native npm run build
npm run build:deploys
npm run serve
```

Open <http://127.0.0.1:4173/>. The local server serves static files and supplies
COOP/COEP headers. `PORT` and `HOST` can override its listen address. Build outputs
are written to `dist/`; source downloads and compiled modules are cached under
`.cache/` and the bridge’s `.native-build/` directory.

If the bridge is checked out next to the playground, native extension compilation
also supports `../mariadb-wasm-bridge` as its source directory. The static build
uses `../mariadb-wasm-bridge/.native-build/upstream` as its default compiled-driver
directory; all bridge JavaScript and engine assets come from the verified release.

## Build provenance

`package-lock.json` pins the npm packages and their integrity values.
`versions.json` pins upstream source revisions, PHP source checksums, the MariaDB
release archive checksum, native and adapter source hashes, Joomla distributions,
and compatible runtime combinations.

The build verifies every entry in the MariaDB bridge 0.1.8 release inventory and
stages its runtime, PHP adapter, engine JavaScript and WebAssembly directly from
that release. Native driver source hashes must match the same release. The
PDO extension’s compiler, PHP version, source hashes, upstream revision, and
binary hash must also match. Native fileinfo, cURL and Sodium modules retain
their matching source inventories, compiler identities and licenses. The CGI
JavaScript adapter records original and adjusted hashes. Each Joomla archive is
verified before staging. A missing driver or mismatched input fails the build.

`dist/assets/manifest.json` records the selected runtimes, extension assets,
preload files, source revisions, and dependency identities. Its `bridge.release`
entry identifies the published release archive. Its complete inventory is retained
under the bridge's versioned asset directory; copied runtime and engine assets retain
their released hashes.
`dist/asset-inventory.json` records the files, sizes, and SHA-256 values in the
assembled site. Updating a dependency means updating its pins, rebuilding its
matching native modules, and running the complete validation suite.

## PHP HTTP requests

PHP’s `curl_*` functions and HTTP stream wrappers perform real HTTP requests
through the upstream Fetch integration. cURL supports request methods, headers,
binary bodies, status codes, redirects, timeouts, and streaming response
callbacks. The native extension is exercised on every supported PHP build,
including the HTTP patterns used by JCB’s file and API helpers.

A small native HTTP stream adapter is compiled into the loadable cURL extension.
It preserves `file_get_contents()`, `fopen()`, `get_headers()`, stream contexts,
response-header metadata and caller-local `$http_response_header`, using the same
browser transport. The upstream PHP binary remains unchanged. A version-independent
JCB compatibility guard skips unavailable image-format identifiers instead of
claiming support for decoders absent from the runtime. If JCB cannot cache a public
image, its image helper can display the original HTTPS URL directly. A missing
cache reference can use the existing file verified against its metadata checksum.
These corrections use the installed component’s own metadata; no artwork copies or host lists are
maintained, and PHP reads still require CORS permission.

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

On normal entry, Playground selects the last successfully used saved site, or
JCB when none exists, and shows a ten-second startup countdown. **Stop countdown**
cancels automatic launch; **Launch** opens the staged target immediately. Opening
configuration or manually selecting a saved site also cancels the countdown.
Manual selections wait for Launch and leave the current site running. Use
`?start=0` to load setup without a countdown; explicit deployment/share links keep
their own configuration and review requirements.

The chevron opens one dashboard containing saved-site management, runtime
configuration, site actions and appearance. **Site** and **Admin**, beside
Deployment, navigate the existing preview without reinstalling Joomla or starting
another runtime. Admin uses the normal Joomla authentication flow. The slim
header scrolls with the page. The supplied pearl rocket identifies the favicon,
Deployment, Launch and progress views. Activity remains below the site; About in
the footer lists the technology repositories and distributed notices.

Appearance defaults to **System**, follows operating-system changes live, and
can be overridden with **Light** or **Dark**. The choice is scoped to this tab
session and survives reload; it synchronizes Code, dialogs, the assistant and
detached editor windows. It does not restyle the embedded Joomla template.

The main **JoomEngine Code** action toggles the editor without discarding its
buffers. Its compact header keeps layout/window controls available when action
labels collapse at narrower editor widths. **Accounts** opens AI API settings;
the robot-shaped **AI Assistant** uses the same isolated session connection. See
the [Code guide](docs/joomengine-code-user-guide.md#optional-ai-editing).

The deployment editor selects Joomla, PHP, packages, languages, the site name,
login behavior, menus and a template. It can install a component from a public
ZIP URL, make one of its frontend views the Home menu item, install a template,
and set its parameters. Installed components, menu layouts and template styles
can be discovered from the running site. See the [deploy guide](deploys/README.md)
for the complete document format and advanced parameters.

Under **Extension packages**, paste a complete HTTP or HTTPS ZIP URL. Use
**Add another URL** for more packages, or remove an unwanted row. The separate
**Advanced options** control exposes the same packages as editable JSON objects
with `url` and an optional `sha256`. Both representations stay synchronized;
invalid JSON remains visible until corrected. Changing a package URL clears its
previous checksum. Joomla console commands remain available under the general
advanced configuration. External hosts must allow browser downloads, and an
HTTPS playground may block HTTP package downloads.

- **Use** starts an independent deployment from the editor's configuration and
  prepares a reusable share link.
- **Apply to this site** checkpoints the running site before installing new
  packages or applying configuration. If an operation fails, the recovery action
  restores that checkpoint as a separate site. Removing a package from the editor
  does not uninstall an already installed extension.
- **Keep this site** stages the persistence choice for the next launch. **Save**
  saves the running site's files and database. Saving a temporary site copies its
  current state into persistent storage, including credentials, and transfers the
  open Code session and recoverable drafts to that saved identity.
- **Restart** restarts PHP with the current settings while preserving the site,
  including a temporary site's files and database.
- **Close** shuts down the workers and releases the site lock. Closing a temporary
  site discards its state after confirmation.
- **Reset** deletes the running site's files and database after confirmation,
  or the staged saved key when no site is running. It is separate from saved-entry
  management.
- **Recover saved site** opens storage without booting Joomla. Download a backup,
  then restore safe error settings if needed; the original configuration is kept
  privately. If MariaDB cannot start, recovery opens the saved PHP files read-only
  so they can be downloaded without changing either saved store. That recovery
  ZIP contains files and private settings, but no SQL database; it does not repair
  a failed database. **Reset and launch** provides an explicit fresh start from the failure screen.
- **New site** stages an independent configuration; the current runtime stays
  open until Launch completes its dirty-work checks.
- **Rename** changes the selected saved entry's display label, preserving its
  storage key, Joomla title, files and database.
- **Delete saved site** names and removes the selected saved entry, files,
  database and editor drafts after confirmation. An inactive entry is deleted
  without launching it. Locked or failed deletion retains its management entry
  so it can be retried.
- **Download** exports the complete site, its files, or its SQL database.
- **Hide controls** in either the header or footer hides both bars, settings and
  activity together. Joomla keeps the same running iframe, current page and
  unsaved work. Small restore tabs occupy the top-left and bottom-left document
  boundaries and scroll away in the middle of a long page. Each reveals the
  controls and scrolls to its corresponding header or footer without restarting
  or transferring the site.

Persistence is enabled by default. Joomla files, session data, cookies and the
MariaDB database are kept in IndexedDB. A site key identifies saved data on this
origin. Returning normally to the domain stages the last saved site and restores
its last safe in-site route when the startup countdown or Launch opens it. Route
metadata excludes action/security parameters and credentials; a missing resumed
page falls back to the initial route. Explicit URL or edited initial-page choices
remain authoritative. Temporary sites do not replace the last saved-site preference.

The saved-site selector, PHP/Joomla controls and deploy choices stage changes;
Launch validates them before closing the current runtime. Only one tab may own a
saved site at a time. Applying a staged PHP choice preserves saved content.
Changing the Joomla release or deploy selects a separate profile, rather than
upgrading an existing installation. Saved metadata migrates without the previous
40-entry pruning, and display names remain separate from setup identity.
MariaDB bridge 0.1.8 checkpoints InnoDB before flushing its filesystem to browser
storage. Playground reserves the PHP request queue until both the site files and
database finish saving, including during configuration changes and PHP restarts.
A successful Save can therefore be reopened after a
whole-page reload without using Close first. Checkpoint or storage errors remain
visible save failures; they do not advance the saved-state indicator.

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

Each extension, template or language ZIP installed by the deployment helper gets
180 seconds of PHP execution time and a 210-second host deadline. The allowance
is applied only to that installer request: ordinary page requests and Joomla's
administrator upload interface retain the selected PHP settings (60 seconds by
default). Preset and manually supplied packages use the same installation policy.
A timeout stops setup without replaying the installer or marking the site ready;
the partially installed site requires recovery or a fresh deployment.

JavaScript callers of `installExtension(runtime, bytes, options)` can set
`executionTimeSeconds` to an integer from 5 to 300. Its default is independent of
`phpSettings.max_execution_time`, so an explicit smaller installation allowance
is respected. Optional `timeoutMs` must allow at least 30 seconds beyond that PHP
allowance and cannot exceed 600,000 milliseconds. Invalid or contradictory
budgets are rejected before the package is written. Host deadlines start when
the operation leaves the runtime queue, and a host timeout terminates the PHP
worker in both browser and Node build runtimes. Raising only `timeoutMs` does not
raise PHP's execution allowance.

Shared configurations with custom packages, commands or site content pause for
review before launching. Installed code shares the playground origin and can access
other sites saved on that origin; separate site keys are an organizational feature.

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

The dashboard's Joomla Language and the Deployment dialog's Site Languages use
the same selected-version catalog. Focus or open either selector to browse tags
and language names, or type to filter and enter a custom tag. Site Languages
supports multiple removable selections. Script subtags such as `sr-Latn-RS` are
accepted; a custom tag still needs a usable pinned or explicitly configured
language package before launch. Entering a tag alone does not install an
unavailable package.

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

MariaDB uses a 128 MiB server packet limit and a 64 MiB initial InnoDB buffer pool.
Transport bounds are 32 MiB per JSON request, 64 MiB per JSON response and 128 MiB
of queued requests. These are operation limits, not a small total-database quota:
base64 encoding, PHP memory and the database heap still constrain individual results.
Exports transfer large values in bounded chunks and report destination packet limits.
Database-limit controls in Rocket are deferred; the bridge already exposes bounded
startup options and MariaDB's supported settings for future integration.

Runtime health checks require the real PDO MySQL bridge, cURL, fileinfo, Sodium,
GD, Intl, mbstring, OpenSSL, DOM, SimpleXML, XML/reader/writer, JSON, ZIP and zlib
extensions. Provisioning checks exercise image decoding, Unicode/XML, archives,
cryptography, database access and uploads. GD supports JPEG, PNG and WebP; AVIF
and XPM are not built into this runtime. The [official Joomla Docker image](https://github.com/joomla/docker-joomla)
is a setup reference, while browser limitations remain explicit below.

The Joomla 6 **JCB + MCP** deploy installs the unchanged MCP package and configures
its native Joomla token-authenticated HTTP endpoint for clients in the same browser.
Deployment verification exercises HTTP initialization, tool discovery and an action
description. Executing actions that call Joomla's API again also requires nested
PHP request support; discovery alone does not verify those operations. Native
processes and stdio are outside this integration. See [the MCP integration notes](dependencies/mcp/README.md).

## Embedding and URL configuration

Repository deploys define packages, language packs, content, and console
commands. See the [contributor guide and schemas](deploys/README.md) to add
another recipe. The default is `jcb` on both Joomla 5 and Joomla 6;
`blank` installs Joomla alone. Deployment documents can also be composed entirely
in the interface without changing this repository.

- [JCB — default on Joomla 5 or 6](https://playground.joomengine.org/?deploy=jcb)
- [JCB + MCP — optional on Joomla 6](https://playground.joomengine.org/?deploy=jcb-mcp)
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
Prepared copies match an exact Joomla release. JCB and the heritage demonstration
are prepared for both catalog releases. Opening JCB restores the installed files
and database instead of repeating its installer. Administrator credentials are
rotated on every new import; PHP settings and explicit extension, language, menu
and template choices still apply. `fresh=1` builds the original recipe instead.

Prepared JCB copies use the stable package releases pinned in
[deploys/jcb.json](deploys/jcb.json): currently JCB 5.2.0 and 6.2.0. To adopt a new
stable release, update its versioned URL and SHA-256 in that recipe and the
optional MCP recipe, update any applicable compatibility inputs, and rebuild.
CI installs and independently restores the new copies before publishing them.
Existing saved sites are preserved. A new deployment uses a prepared copy only
when its exact Joomla/JCB selection matches that copy; other listed versions
install automatically from their verified staged packages. Updating the prepared
recipe and rebuilding remains necessary to publish a new prepared snapshot.

The interface recognizes these query parameters:

| Parameter | Meaning |
| --- | --- |
| `deploy=jcb` | Choose a repository deploy; `blank` installs Joomla alone |
| `joomla=5.4` | Resolve a minor or exact version to a tested catalog release |
| `php=8.5` | Select the PHP minor whose patch version is pinned in the catalog |
| `path=/administrator/` | Initial page inside Joomla |
| `toolbar=0` | Hide the header and footer together, with edge tabs to restore them |
| `persist=0` | Use a temporary site |
| `language=en-GB` | Select the Joomla language; another supported tag installs its pack |
| `uiLanguage=af` | Select Rocket's interface language independently |
| `name=Client%20demo` | Set the Joomla site name |
| `login=no` | Start or reopen with the administrator logged out |
| `fresh=1` | Create an independent site from the recipe |
| `key=example` | Reopen a saved site in this browser |
| `extensions=[...]` | Additional objects containing `url` and optional `sha256` |
| `commands=[["cache:clean"]]` | Additional Joomla console argument arrays |
| `start=0` | Show setup first; the default page offers a ten-second countdown |
| `config=https://example.org/deploy.json` | Load a public deployment document, optionally verified with `sha256` |

For a deployment hosted at `/playground/`, this same-origin iframe opens an
administrator playground with the header and footer hidden:

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
headers. `toolbar=0` starts with both bars hidden and the same restore tabs
available. A raw site-preview URL still requires its owning playground tab.
**Share** launches an independent installation from the same public deployment
configuration; hiding controls keeps the current site running in its original tab.

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
      phpVersion: '8.5',
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
| `exportSite({ format })` | Return `{ bytes, filename, mimeType, metadata }`; format is `bundle`, `files`, or `database` |
| `recovery` | Recovery metadata when opened with `createPlayground(config, { recovery: true })` |
| `repairConfiguration()` | Back up configuration and restore safe Joomla debugging/error settings |
| `exportRecoveryFiles()` | Download raw saved files, including private credentials and sessions; does not include SQL |
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
Cross-Origin-Embedder-Policy: credentialless
```

MariaDB requires `SharedArrayBuffer`, a secure context, and cross-origin
isolation. The playground also requires service workers, IndexedDB, and Web
Locks. GitHub Pages cannot configure these response headers directly, so the
included service worker adds them to controlled responses and the interface
reloads once to activate isolation. That worker also handles the PHP site routes;
do not replace it with an unrelated isolation worker.

The credentialless policy allows ordinary public images, classic scripts, and
stylesheets to load directly from their original hosts without requiring CORS or
CORP response headers. These cross-origin `no-cors` requests omit cookies and
other credentials. Fonts, JavaScript modules, and requests that read remote data
still follow normal CORS rules; an explicit remote CORP restriction is respected.
No extension-specific image URLs or artwork snapshots are maintained.

Current desktop Chromium and Firefox are the validated browser targets. The
required `COEP: credentialless` policy is not currently supported by Safari/iOS
or Firefox for Android. Those browsers cannot run this release's combined
MariaDB and public-asset setup; the interface stops with a compatibility message
after the single isolation reload instead of silently applying a policy that
breaks extension assets. Responsive layout does not imply runtime support on
every mobile browser.

The **Publish playground to Pages** workflow runs on every push or merge to
`main`, daily at 03:15 UTC to refresh the current and nightly packages, and can
also be started manually on `main`. It validates first, then deploys that exact
tested artifact through the `github-pages` environment. Scheduled runs use the
same checks and installation gates as other releases. Upstream download failures
or failed validation prevent deployment and leave the last published site intact.

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
MARIADB_DRIVER_DIR=.cache/native npm run build
npx playwright install --with-deps chromium firefox
npm run test:provisioning
npm run build:deploys
npm run test:browser
node --test test/version-catalog.browser.mjs
```

The browser suite uses real PHP, native PDO, MariaDB, and Joomla. It exercises
catalog combinations, administrator access, extension installation, configuration,
persistence, temporary-site retention, restart, PHP settings, exports, sharing,
live header/footer hide-and-restore controls, responsive layout and timeout recovery.
The prepared JCB regression creates a Joomla record and changes its configuration
file, then verifies both and administrator access after two Save → whole-page
reload cycles without Close. Recovery checks verify that exporting files after
a database startup failure leaves the saved file and database stores unchanged.
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
A separate Chromium/Firefox version-catalog job installs the actual staged
selection packages from that same candidate artifact and retains receipts in
`test-results/`. Its success is required whenever a build is selected; it does not
replace the existing runtime or interaction checks.
Warm-cache presentation changes reuse already validated native extensions and skip
the duplicate complete provisioning suite; runtime changes and native cache misses
still execute those contracts.

An installed fixture extension must render its own nested image, stylesheet and
script; a separate fixture verifies external resources alongside native database
queries. Missing images, scripts, styles and fonts fail validation, with their
URLs and browser diagnostics retained. A controlled cross-origin PHP read also
verifies that a denied request reports its error promptly and leaves PHP and the
database usable. The playground does not replace artwork or hide production errors.

Firefox 157 emits an empty-URL service-worker diagnostic for some successful native
redirects, including a minimal `Response.redirect()` with no playground runtime.
The browser suite reproduces that behavior independently, then records it separately
only for verified Joomla form and language redirects with the same exact diagnostic.
Receipts retain the complete messages and HTTP proof. Other console errors still
fail validation, and production console output is not suppressed. The isolated
reproduction is in [test/firefox-redirect-probe.mjs](test/firefox-redirect-probe.mjs).

## Scope and limitations

This is a browser-local environment for trusted development and demonstrations.
Installed extensions and PHP code run with access to that playground’s files and
database. Keep independent applications in separate site keys; this is not a
multi-tenant hosting boundary.

The bridge supports up to 32 independent PDO connections per MariaDB instance,
uses PDO emulated prepares, and does not implement `mysqli` or remote database connections. Integer
values within PHP’s integer range are returned as integers; larger integers and
DECIMAL values remain exact strings. `PDO::ATTR_STRINGIFY_FETCHES` requests
numeric strings explicitly. Files and database state are separate stores; they
are not committed together as one transaction.

The verified JavaScript CGI adapter supports binary POST, PUT, PATCH and
DELETE bodies, including large multipart uploads. It awaits preload completion
before restoring a restarted runtime’s files. Request queues, source size,
body size and execution time remain bounded. A recoverable PHP application error
preserves its HTTP error response and files, resets abandoned database sessions,
and prepares PHP for the next request without replaying uncertain writes. On a
worker timeout, use the recovery controls or restart the instance.

Host processes, system executables, arbitrary socket services, and a production
mail server are not supplied by this static playground. Extensions that require
those facilities need a different environment. Installing an extension and passing
runtime health checks does not prove every workflow of every Joomla extension is
browser-compatible; exercise the particular component operations you plan to
demonstrate. Browser storage, WebAssembly memory and CORS still apply.
