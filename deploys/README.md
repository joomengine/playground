# Playground deploys

Deploys describe a reproducible Joomla installation: extension packages, languages, sample content and Joomla CLI commands. The application defaults to **JCB + MCP on Joomla 6** and **JCB only on Joomla 5**. Ordinary deployments start in English. Choose **Joomla only** or `?deploy=blank` to start without additional extensions. The low-level `createPlayground()` API installs only the configuration supplied by its caller.

| Deploy | Open the playground | Contents |
| --- | --- | --- |
| `jcb-mcp` | [JCB + MCP](https://playground.joomengine.org/?deploy=jcb-mcp) | Joomla 6 with JCB and the Joomla-native MCP package |
| `servicedirectory` | [Service Directory](https://playground.joomengine.org/?deploy=servicedirectory) | Service Directory for Joomla 5 or 6, with its directory view as Home |
| `jcb` | [Joomla Component Builder](https://playground.joomengine.org/?deploy=jcb) | Complete JCB package selected for Joomla 5 or 6 |
| `blank` | [Joomla only](https://playground.joomengine.org/?deploy=blank) | Clean Joomla installation |
| `heritage-demo` | [Multilingual heritage site](https://playground.joomengine.org/?deploy=heritage-demo) | Afrikaans-first home pages and content in all eight configured languages |
| `patchtester` | [Patch Tester](https://playground.joomengine.org/?deploy=patchtester) | Official Patch Tester component |
| `weblinks` | [Weblinks](https://playground.joomengine.org/?deploy=weblinks) | Official Weblinks package |

Add `&fresh=1` to build the selected recipe from its packages and commands, bypassing any compatible prepared copy. The application allocates a new saved-site key for a fresh launch, so existing saved sites remain available.

## Contributing a recipe

1. Add `deploys/<id>.json` using [schema.json](schema.json). IDs use lowercase letters, digits and hyphens.
2. Add its title, description and `"file": "./<id>.json"` to [catalog.json](catalog.json). The [catalog schema](catalog.schema.json) describes the registry.
3. Pin each package to a versioned HTTPS URL and its SHA-256 digest. Check the downloaded bytes against the publisher's checksum when available. Avoid moving branches and mutable latest-release URLs.
4. Declare supported Joomla major versions. Use `variants` when they need different package releases or setup options.
5. Run `npm test` and the browser validation for the supported PHP/Joomla combinations. Check that the extension installs, its administrator page opens, and exported/restored sites work.

The Weblinks recipe is a complete example:

```json
{
  "$schema": "./schema.json",
  "schemaVersion": 1,
  "id": "weblinks",
  "title": "Weblinks",
  "joomla": ["5", "6"],
  "configuration": {
    "initialPath": "/administrator/index.php?option=com_weblinks",
    "extensions": [{
      "url": "https://github.com/joomla-extensions/weblinks/releases/download/5.2.0/pkg-weblinks-5.2.0.zip",
      "sha256": "3f5a0081d64b857729711107d54fab6613f0b1e8c5c211a301972c29e42639ad"
    }]
  }
}
```

Common configuration is applied first, then the selected Joomla major's variant, then explicit URL or caller settings. Extension and CLI arrays append in that order. Duplicate package URLs with identical checksums are installed once; conflicting checksums fail validation. All merged arrays remain subject to the configured size limits. Recipes cannot define administrator credentials.

The build verifies repository package digests and stages them under the playground's own origin. Staged recipes retain the publisher URL as `sourceUrl` and use relative local asset URLs. Runtime validation in `src/deploys.mjs` also checks relationships that JSON Schema cannot express, including catalog IDs, category references and supported variants.

## Languages and content

The `language` setting selects the default Joomla language. English (`en-GB`) is included in Joomla. Other languages need a pinned installer package, either in the recipe's `languages` array or the catalog's Joomla-major language registry. Afrikaans (`af-ZA`), German (`de-DE`), French (`fr-FR`), Italian (`it-IT`), Spanish (`es-ES`), Chinese Simplified (`zh-CN`) and Dutch (`nl-NL`) are registered for both supported Joomla majors. The multilingual heritage deployment includes all of them plus English, with Afrikaans first and default. This does not change the English default of ordinary deployments or the independently selected Rocket interface language. A language package has `tag`, `url` and `sha256` fields.

The heritage recipe demonstrates `content` with these fields:

- `multilingual`: enables content languages, language filtering and switching.
- `categories`: objects with unique `key`, `title`, URL `alias` and `language`.
- `articles`: objects with unique `key`, `title`, `alias`, `language`, a category `key` in `category`, and HTML `introtext`. Optional fields are `fulltext`, `featured` and `home`.

Give each language a home article when using multilingual content. All referenced languages must have a package or be the built-in English language. HTML and commands are part of the reviewed recipe; they run inside the browser's Joomla installation.

## URL configuration and sharing

Supported deployment parameters include:

| Parameter | Example | Effect |
| --- | --- | --- |
| `deploy` | `heritage-demo` | Select a repository recipe; `blank` or `none` selects Joomla only |
| `joomla` | `5.4` | Select the latest tested patch release in that minor series |
| `php` | `8.5` | Select an available compatible PHP runtime |
| `name` | `Client demo` | Set the Joomla site name |
| `language` | `af-ZA` | Install and select the configured language |
| `login` | `no` | Open the site logged out |
| `fresh` | `1` | Build from the recipe instead of importing its prepared copy |
| `path` | `/administrator/` | Select the first Joomla page |
| `persist` | `1` | Save changes in this browser |
| `key` | `my-demo` | Select a local saved-site key |
| `toolbar` | `0` | Hide the playground toolbar |
| `start` | `0` | Load the configuration without starting automatically |

`extensions` accepts a JSON array of `{ "url": "…", "sha256": "…" }` objects. A checksum is optional for caller-supplied URLs and mandatory for repository packages. Repeated `extension=URL` parameters provide a shorter URL-only form. External URLs must allow browser downloads through CORS.

`commands` accepts JSON arrays of Joomla CLI argument arrays. Use a command such as `["cache:clean"]`, without `php`, `cli/joomla.php` or a shell prefix. Arguments are passed directly to the Joomla CLI, without shell interpolation. `startupCommands` is an alias for `commands`.

Build encoded links with the URL API:

```js
const url = new URL('https://playground.joomengine.org/');
url.searchParams.set('deploy', 'blank');
url.searchParams.set('joomla', '5.4');
url.searchParams.set('php', '8.5');
url.searchParams.set('language', 'en-GB');
url.searchParams.set('login', 'no');
url.searchParams.set('commands', JSON.stringify([['cache:clean']]));
```

Share links include the selected deployment, site name, runtime/PHP settings, menus, template, languages and explicit extension/CLI additions. They do not contain the administrator account, password, local saved-site key or site data. Use public package URLs and public setup arguments in a link intended for sharing.

## Prepared copies

`prebuild: true` requests generation of a portable prepared copy during the build. The heritage recipe uses this option. Build output adds verified snapshot metadata to each supported Joomla variant; source recipes need no placeholder snapshot URL.

A snapshot contains `site/`, `database.sql` and `export.json`, and declares `format: "joomengine-playground-export"`, `schemaVersion: 1`, an exact `joomlaVersion`, `url` and `sha256`. Snapshot contents are PHP-runtime independent. A snapshot is selected only for its exact Joomla release and when `fresh` is false. Explicit user extension and CLI additions run after import; the prepared recipe's installation steps are not repeated.

## Resolver API

```js
const { configuration, deploy } = await resolveDeployConfiguration(input, {
  catalog: runtimeCatalog,
  deployCatalog: await loadDeployCatalog(),
  baseURL: location.href,
});
```

`configuration` is validated for `createPlayground()` and includes `deployId`, complete installation arrays, and an optional compatible `snapshot`. `addonExtensions`, `addonStartupCommands` and `addonLanguages` preserve caller-only additions for snapshot import. Retain the original caller configuration when creating a share link so expanded recipe commands are not duplicated.


## Compose a deployment without a repository change

Use the Rocket deployment editor to select packages, PHP settings, languages, menus and a template. **Use** validates the configuration and starts an independent site; **Apply to this site** changes a running site after a checkpoint. Applying deployment changes does not reinstall Joomla or change its major version. Package installation and Joomla console commands can make application-specific changes, so review them before applying.

The portable JSON document uses [document.schema.json](document.schema.json). It contains public installation instructions, not a saved site or administrator credentials. A complete working example using Joomla's built-in component and template is:

```json
{
  "schemaVersion": 1,
  "configuration": {
    "deployId": "blank",
    "joomlaVersion": "6.2.0",
    "phpVersion": "8.4",
    "siteName": "Client demonstration",
    "language": "en-GB",
    "autoLogin": false,
    "initialPath": "/",
    "phpSettings": {
      "upload_max_filesize": "128M",
      "post_max_size": "160M",
      "max_execution_time": 60,
      "max_input_time": 60,
      "max_input_vars": 10000,
      "memory_limit": "512M"
    },
    "menus": [{
      "key": "home",
      "title": "Home",
      "alias": "home-demo",
      "menuType": "mainmenu",
      "component": "com_content",
      "view": "featured",
      "language": "*",
      "home": true
    }],
    "template": {
      "element": "cassiopeia",
      "params": { "fluidContainer": 1 }
    }
  }
}
```

The share panel encodes advanced configurations in a `#deploy=` fragment. It always shows the resulting URL, even when clipboard permission is unavailable. Generated links are limited to 16 KiB. Larger documents can be downloaded as JSON, imported in the editor, or hosted at a public HTTPS URL and opened with `?config=URL&sha256=DIGEST`. The configuration host must allow browser downloads through CORS. The optional digest covers the exact JSON file bytes; a mismatch stops deployment. Documents are limited to 1 MiB.

Programmatic consumers can import `createDeploymentDocument`, `parseDeploymentDocument`, `loadDeploymentDocument`, `createShareURL` and `createDeploymentSourceURL` from `src/config.mjs`. Parsing returns the public configuration; the resolver then adds the selected preset and validates runtime compatibility. Neither documents nor generated share links include local storage keys, administrators, passwords or API tokens. Never put private credentials in package URLs, parameters or console commands.

## Menus, templates and languages

Menu items use `key`, `title`, `alias`, `menuType`, `component`, `view`, `query`, `params`, `language`, `home`, `published`, `access` and `templateStyle`. Only title, component and view are required; defaults are a published public item in `mainmenu`, for all languages. `query` contains scalar component view arguments, such as an article or category ID. It cannot replace `option`, `view`, `task`, `Itemid` or the response format. `params` contains the component's menu parameters. There may be one declared home item per language.

Packages install before menu configuration. The editor can discover the actual installed component menu types and template styles. Joomla's own models validate and save these records. Applying a menu with the same menu type, alias and language updates the existing record rather than creating a duplicate.

A template may contain a package `url` and optional `sha256`, followed by its `element` or installed `styleId`, `params`, and optional `menuKeys`. Without `menuKeys`, it becomes the default site template. With assignments, only the named deployment menu items receive that style. The template must be installed and enabled; its own Joomla form validates parameters.

`languageTags` requests installation of selected language packs. `language` selects the site's default language. Setting `multilingual: true` also creates content-language records and activates Joomla's language filter and switcher. A custom multilingual deployment needs one published home item per selected language. The heritage preset supplies articles, categories and associated homes for all eight languages. Interface language is a separate browser preference and does not change Joomla content.

PHP settings are an allowlist of the six documented settings. The runtime reports effective values after restarting PHP, and upload/body limits are checked together. The default POST limit includes multipart overhead above the 128 MiB file limit. PHP changes preserve the site files, database and credentials.
