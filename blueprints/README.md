# Playground blueprints

Blueprints describe a reproducible Joomla installation: extension packages, languages, sample content and Joomla CLI commands. The application defaults to **Joomla Component Builder**. Choose **Joomla only** or `?blueprint=blank` to start without additional extensions. The low-level `createPlayground()` API installs only the configuration supplied by its caller.

| Blueprint | Open the playground | Contents |
| --- | --- | --- |
| `jcb` | [Joomla Component Builder](https://playground.joomengine.org/?blueprint=jcb) | Complete JCB package selected for Joomla 5 or 6 |
| `blank` | [Joomla only](https://playground.joomengine.org/?blueprint=blank) | Clean Joomla installation |
| `heritage-demo` | [Multilingual heritage site](https://playground.joomengine.org/?blueprint=heritage-demo) | English and Dutch home pages, categories and language switching |
| `patchtester` | [Patch Tester](https://playground.joomengine.org/?blueprint=patchtester) | Official Patch Tester component |
| `weblinks` | [Weblinks](https://playground.joomengine.org/?blueprint=weblinks) | Official Weblinks package |

Add `&fresh=1` to build the selected recipe from its packages and commands, bypassing any compatible prepared copy. The application allocates a new saved-site key for a fresh launch, so existing saved sites remain available.

## Contributing a recipe

1. Add `blueprints/<id>.json` using [schema.json](schema.json). IDs use lowercase letters, digits and hyphens.
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

The build verifies repository package digests and stages them under the playground's own origin. Staged recipes retain the publisher URL as `sourceUrl` and use relative local asset URLs. Runtime validation in `src/blueprints.mjs` also checks relationships that JSON Schema cannot express, including catalog IDs, category references and supported variants.

## Languages and content

The `language` setting selects the default Joomla language. English (`en-GB`) is included in Joomla. Other languages need a pinned installer package, either in the recipe's `languages` array or the catalog's Joomla-major language registry. Dutch (`nl-NL`) is registered for both supported Joomla majors. A language package has `tag`, `url` and `sha256` fields.

The heritage recipe demonstrates `content` with these fields:

- `multilingual`: enables content languages, language filtering and switching.
- `categories`: objects with unique `key`, `title`, URL `alias` and `language`.
- `articles`: objects with unique `key`, `title`, `alias`, `language`, a category `key` in `category`, and HTML `introtext`. Optional fields are `fulltext`, `featured` and `home`.

Give each language a home article when using multilingual content. All referenced languages must have a package or be the built-in English language. HTML and commands are part of the reviewed recipe; they run inside the browser's Joomla installation.

## URL configuration and sharing

Supported deployment parameters include:

| Parameter | Example | Effect |
| --- | --- | --- |
| `blueprint` | `heritage-demo` | Select a repository recipe; `blank` or `none` selects Joomla only |
| `joomla` | `5.4` | Select the latest tested patch release in that minor series |
| `php` | `8.5` | Select an available compatible PHP runtime |
| `language` | `nl-NL` | Install and select the configured language |
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
url.searchParams.set('blueprint', 'blank');
url.searchParams.set('joomla', '5.4');
url.searchParams.set('php', '8.5');
url.searchParams.set('language', 'nl-NL');
url.searchParams.set('login', 'no');
url.searchParams.set('commands', JSON.stringify([['cache:clean']]));
```

Share links include the selected recipe, runtime options and explicit extension/CLI additions. They do not contain the administrator account, password, local saved-site key or site data. Use public package URLs and public setup arguments in a link intended for sharing.

## Prepared copies

`prebuild: true` requests generation of a portable prepared copy during the build. The heritage recipe uses this option. Build output adds verified snapshot metadata to each supported Joomla variant; source recipes need no placeholder snapshot URL.

A snapshot contains `site/`, `database.sql` and `export.json`, and declares `format: "joomengine-playground-export"`, `schemaVersion: 1`, an exact `joomlaVersion`, `url` and `sha256`. Snapshot contents are PHP-runtime independent. A snapshot is selected only for its exact Joomla release and when `fresh` is false. Explicit user extension and CLI additions run after import; the prepared recipe's installation steps are not repeated.

## Resolver API

```js
const { configuration, blueprint } = await resolveBlueprintConfiguration(input, {
  catalog: runtimeCatalog,
  blueprintCatalog: await loadBlueprintCatalog(),
  baseURL: location.href,
});
```

`configuration` is validated for `createPlayground()` and includes `blueprintId`, complete installation arrays, and an optional compatible `snapshot`. `addonExtensions`, `addonStartupCommands` and `addonLanguages` preserve caller-only additions for snapshot import. Retain the original caller configuration when creating a share link so expanded recipe commands are not duplicated.
