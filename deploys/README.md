# Playground deploys

Deploys describe a reproducible Joomla installation: extension packages, languages, sample content and Joomla CLI commands. The application defaults to **JCB on Joomla 5 and Joomla 6**, using **PHP 8.4** and opening the JCB dashboard. PHP 8.5 remains selectable. **JCB + MCP** is an optional Joomla 6 deployment. Ordinary deployments start in English. Choose **Joomla only** or `?deploy=blank` to start without additional extensions. The low-level `createPlayground()` API installs only the configuration supplied by its caller.

| Deploy | Open the playground | Contents |
| --- | --- | --- |
| `jcb` | [Joomla Component Builder](https://playground.joomengine.org/?deploy=jcb) | Complete JCB package selected for Joomla 5 or 6 |
| `jcb-mcp` | [JCB + MCP](https://playground.joomengine.org/?deploy=jcb-mcp) | Joomla 6 with JCB and the Joomla-native MCP package |
| `servicedirectory` | [Service Directory](https://playground.joomengine.org/?deploy=servicedirectory) | Service Directory for Joomla 5 or 6, with its directory view as Home |
| `blank` | [Joomla only](https://playground.joomengine.org/?deploy=blank) | Clean Joomla installation |
| `heritage-demo` | [Multilingual heritage site](https://playground.joomengine.org/?deploy=heritage-demo) | Afrikaans-first home pages and content in all eight configured languages |
| `patchtester` | [Patch Tester](https://playground.joomengine.org/?deploy=patchtester) | Official Patch Tester component |
| `weblinks` | [Weblinks](https://playground.joomengine.org/?deploy=weblinks) | Official Weblinks package |

Add `&fresh=1` to build the selected recipe from its packages and commands, bypassing any compatible prepared copy. The application allocates a new saved-site key for a fresh launch, so existing saved sites remain available.

## Contributing a recipe

1. Add `deploys/<id>.json` using [schema.json](schema.json). IDs use lowercase letters, digits and hyphens.
2. Add its title, description and `"file": "./<id>.json"` to [catalog.json](catalog.json). The [catalog schema](catalog.schema.json) describes the registry.
3. Pin each package to a versioned HTTPS URL and its SHA-256 digest. Check the downloaded bytes against the publisher's checksum when available. Avoid moving branches and mutable latest-release URLs.
4. Declare supported Joomla major versions and `requirements`: whether JCB is required, any PHP constraints, and explicit Joomla-major fallbacks. Use `variants` when majors need different package releases or setup options.
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

For repository recipes, common configuration is applied first, then the selected Joomla major's variant, then explicit URL or caller settings. Extension and CLI additions append in that order. Saved custom recipes contain complete lists and replace them when edited. Duplicate managed package URLs with identical checksums are installed once; conflicting managed checksums fail validation. Repository recipes cannot define administrator credentials.

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
| `deploy` | `heritage-demo` | Select a repository recipe; `blank` selects Joomla only |
| `joomla` | `5.4` | Select the latest tested patch release in that minor series |
| `php` | `8.5` | Select an available compatible PHP runtime |
| `name` | `Client demo` | Set the Joomla site name |
| `language` | `af-ZA` | Install and select the configured language |
| `login` | `no` | Open the site logged out |
| `fresh` | `1` | Build from the recipe instead of importing its prepared copy |
| `path` | `/administrator/` | Select the first Joomla page |
| `persist` | `1` | Save changes in this browser |
| `key` | `my-demo` | Select a local saved-site key |
| `toolbar` | `0` | Hide the header and footer together; edge tabs restore them without restarting Joomla |
| `start` | `0` | Load the configuration without starting automatically |

`extensions` accepts a JSON array of `{ "url": "…" }` objects; repeated `extension=URL` parameters provide a shorter form. Custom URLs go to Joomla's `extension:install --url=URL` command, and user-supplied checksum fields are ignored. Installer errors remain visible while the site opens. Repository packages retain mandatory verified checksums and must install successfully.

`commands` accepts JSON arrays of Joomla CLI argument arrays. Use a command such as `["cache:clean"]`, without `php`, `cli/joomla.php` or a shell prefix. Arguments are passed directly to the Joomla CLI, without shell interpolation.

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

`prebuild: true` requests generation of a portable prepared copy during the build. The JCB and heritage recipes use this option for both supported Joomla releases. Build output adds verified snapshot metadata to each supported Joomla variant; source recipes need no placeholder snapshot URL.

A snapshot contains `site/`, `database.sql` and `export.json`, and declares `format: "joomengine-playground-export"`, `schemaVersion: 1`, an exact `joomlaVersion`, `url` and `sha256`. Snapshot contents are PHP-runtime independent. A snapshot is selected only for its exact Joomla release and when `fresh` is false. Each new site created from it receives its own configured administrator. Selected PHP settings, language, menus and template still apply. Explicit user extension and CLI additions run after import; the prepared recipe's installation steps are not repeated.

To update prepared JCB installations, select a stable release, update its versioned package URL and SHA-256 in `jcb.json` and (for Joomla 6) `jcb-mcp.json`, then rebuild. Package compatibility inputs must also match the selected release. The build installs the pinned package and independently restores the exported site before it publishes the copy. Existing saved sites are not replaced. This deliberately trades a build on stable-release updates for a faster, repeatable visitor launch.

## Resolver API

```js
const { configuration, deploy } = await resolveDeployConfiguration(input, {
  catalog: runtimeCatalog,
  deployCatalog: await loadDeployCatalog(),
  baseURL: location.href,
});
```

`configuration` is validated for `createPlayground()` and includes `deployId`, complete installation arrays, and an optional compatible `snapshot`. The `addonExtensions`, `addonStartupCommands`, `addonLanguages` and `addonTemplate` fields distinguish custom additions from managed packages. `sourceDeployId` preserves the original deployment's setup behavior. Export and share helpers use this provenance; a materialized custom recipe is not expanded from its original preset again.


## Compose a deployment without a repository change

Use the Rocket deployment editor to select a complete setup, then edit its site settings, administrator, packages, commands, languages, menus and template. Runtime version choices remain on the dashboard. Both places use the same deployment list; the dashboard pencil opens the selected setup. **Save** creates a custom copy of a built-in setup or updates the selected custom deployment; **Save as copy** keeps both. Custom deployment names are distinct, and only custom entries can be deleted. The browser stores these definitions independently of installed Joomla sites.

**Use** starts an independent site; **Apply to this site** changes a running site after a checkpoint. Applying deployment changes does not reinstall Joomla or change its major version. Commands, menu data, template parameters and content have basic forms and an advanced JSON view of the same values.

The portable JSON document uses [document.schema.json](document.schema.json). **Export configuration** writes schema version 2 with `name`, `requirements` and a complete `configuration`, including administrator settings and the provenance of managed versus custom packages. Importing it creates a named custom deployment; a name collision receives a distinct name. Neither a configuration document nor a share link contains the site's files or database.

Public share links continue using schema version 1 and exclude administrator settings. Existing version 1 documents remain importable. A version 2 recipe looks like this:

```json
{
  "schemaVersion": 2,
  "name": "Client demonstration",
  "requirements": { "joomla": ["6"], "jcb": "optional", "php": ["8.4", "8.5"] },
  "configuration": {
    "deployId": "blank",
    "joomlaVersion": "6.2.0",
    "phpVersion": "8.4",
    "siteName": "Client demonstration",
    "language": "en-GB",
    "initialPath": "/",
    "admin": {
      "name": "Site owner",
      "username": "admin",
      "email": "admin@example.test",
      "password": "example-password-123"
    },
    "extensions": [],
    "startupCommands": [],
    "languages": [],
    "template": { "element": "cassiopeia" }
  }
}
```

The share panel encodes advanced public configurations in a `#deploy=` fragment and shows the URL for copying. Generated links are limited to 16 KiB. Larger public documents can be hosted at an HTTPS URL and opened with `?config=URL&sha256=DIGEST`; the host must permit browser Fetch reads. The optional digest covers the exact JSON file bytes. Full version 2 documents are exported and imported through the editor. Documents are limited to 1 MiB.

Programmatic consumers can import `createFullDeploymentDocument`, `createDeploymentDocument`, `parseDeploymentDocument`, `loadDeploymentDocument`, `createShareURL` and `createDeploymentSourceURL` from `src/config.mjs`. `createFullDeploymentDocument(config, { name, requirements })` creates the version 2 document. Its requirements declare Joomla majors, optional PHP constraints, explicit Joomla fallbacks and whether JCB is required. Parsing version 2 returns a `deploymentRecipe` alongside the configuration; the resolver uses those complete lists without appending the original preset again. Public shares carry a standalone sanitized recipe for custom deployments, omitting administrator settings and local storage identities.

## Menus, templates and languages

Menu items use `key`, `title`, `alias`, `menuType`, `component`, `view`, `query`, `params`, `language`, `home`, `published`, `access` and `templateStyle`. Only title, component and view are required; defaults are a published public item in `mainmenu`, for all languages. `query` contains scalar component view arguments, such as an article or category ID. It cannot replace `option`, `view`, `task`, `Itemid` or the response format. `params` contains the component's menu parameters. There may be one declared home item per language.

Packages install before menu configuration. The editor can discover the actual installed component menu types and template styles. Joomla's own models validate and save these records. Applying a menu with the same menu type, alias and language updates the existing record rather than creating a duplicate.

A template may contain a package `url`, followed by its `element` or installed `styleId`, `params`, and optional `menuKeys`. Managed template packages retain their verified checksum; custom template URLs use Joomla's console installer and ignore supplied checksum fields. Without `menuKeys`, the template becomes the default site template. With assignments, only the named deployment menu items receive that style. Its Joomla form validates parameters.

`languageTags` requests installation of selected language packs. `language` selects the site's default language. Setting `multilingual: true` also creates content-language records and activates Joomla's language filter and switcher. A custom multilingual deployment needs one published home item per selected language. The heritage preset supplies articles, categories and associated homes for all eight languages. Interface language is a separate browser preference and does not change Joomla content.

PHP settings are an allowlist of the six documented settings. The runtime reports effective values after restarting PHP, and upload/body limits are checked together. The default POST limit includes multipart overhead above the 128 MiB file limit. PHP changes preserve the site files, database and credentials.

### Managed browser database

Global Configuration can save normal Joomla settings. Database connection credentials and filesystem session storage are managed by Rocket while PHP uses the embedded MariaDB bridge. Changing those fields is rejected with an explanation; export the site to configure a different server. A narrowly scoped, checksum-verified adapter preserves Joomla's native configuration save flow and its original server behavior. See [the reviewed source and adapter provenance](../dependencies/joomla/README.md).

Managed extension ZIPs are limited to 128 MiB. Custom URL installations use Joomla's downloader and installer. Prepared snapshots and private saved-site transfers accept a verified bundle up to 512 MiB compressed; exported and imported bundles share a limit of 100,000 ZIP entries and 768 MiB expanded. PHP upload limits are separate and adjustable in the runtime settings.

## Browser deployment images

Complete site **Download** and **Upload** preserve an existing installation, including its known sandbox credentials and opening page. Those downloads carry configuration in `export.json.playground` and a hash of the site files and database. Internal reusable images omit that restore configuration and receive the new site's administrator when launched.

**Deployment images** manages the prepared images available in this browser. Each image is an independent base for creating sites; removing an image does not delete a saved site's files or database. A later launch downloads a maintained image again or rebuilds a custom image when it is no longer stored locally.

Maintained images follow the server's current build manifest. Before creating a site, the browser revalidates that small manifest and compares its published image hash with the local copy. A changed or removed server image invalidates the older local copy. The replacement ZIP is downloaded only when needed and its SHA-256 is verified before reuse. The manager displays deployment names, runtime versions, availability and size; download addresses remain internal.

A successful initial custom build is exported and stored before the site opens for editing. Later sites with the same effective packages, configuration and runtime restore a separate copy, apply their own site name and administrator, and skip packages and commands already included in the image. Builds with failed optional setup steps are not stored as reusable images. Saved sites continue resuming their own state, and later interactive edits are never silently added to a deployment image.

Changes to build inputs or the playground runtime produce a different custom image identity. Console-command recipes also include the configured site and administrator identity in that comparison because commands may depend on those values. The launch display distinguishes building and saving an image from restoring and launching a site. If browser storage cannot save an image, the completed site still opens normally.
