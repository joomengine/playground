# White-label Playground and fork configuration reference

A fork can launch visitors straight into its own Joomla component, with its own
deployment choices, branding and tools. Keep these files in a tracked `site/`
directory. The official JoomEngine build supplies the browser runtime and its
verified Joomla and PHP versions.

## Publish the working example

1. Fork this repository. In the fork, enable GitHub Actions and select **Settings → Pages → Build and deployment → Source → GitHub Actions**.
2. Under **Settings → Secrets and variables → Actions → Variables**, create the repository variable `PLAYGROUND_FORK_PAGES`. Choose `manual` to publish only when you run the fork workflow, or `true` to enable automatic updates as well.
3. From a local checkout of the fork, copy the example into a new `site/` directory and commit it to the default branch.

   ```sh
   cp -R examples/fork-site site
   git add site
   git commit -m "Set up the Field Notes Playground"
   git push
   ```

4. Open **Actions → Publish fork playground → Run workflow** on the default branch. Open the Pages URL from the deployment when the run finishes. GitHub Pages can serve the fork at its ordinary project URL, including the repository path.

| `PLAYGROUND_FORK_PAGES` in the fork | Publication behavior |
| --- | --- |
| Unset | The fork keeps its existing full source build, package refresh, validation and Pages publication. |
| `manual` | **Run workflow** composes the local site with the published JoomEngine engine. The fork retains that deployment until its next manual run. |
| `true` | In addition to manual runs, the fork checks for upstream publications every four hours and builds changes to `site/` on its default branch. Site pull requests validate without publishing. |

Both opt-in modes replace the fork's full source workflows. The official
JoomEngine repository always builds from source and publishes the shared engine.

The example opens Joomla's Articles manager with one field report ready to
edit. It uses PHP 8.4 and a single deployment. The header logo, colors and
footer belong to Field Notes. [Example profile and recipe](../examples/fork-site/)

## Choose what the fork owns

| File in your fork | Purpose |
| --- | --- |
| `site/playground.json` | Optional site name, branding, features, PHP default and public URL. |
| `site/deploys/catalog.json` | Optional complete list of visible deployments, their order and defaults. Without it, the official catalog supplies the list. |
| `site/deploys/<id>.json` | Complete recipe for a listed ID. This takes precedence over the upstream recipe with that ID. |
| `site/assets/` | Brand images, favicon and assets referenced by the theme. |
| `site/theme.css` | Optional final stylesheet for the Playground interface. The Joomla site inside the frame uses its own template. |

To add your extension, edit the example recipe's `configuration.extensions`
to contain your released installer package URL and SHA-256 digest. Set
`configuration.initialPath` to the front-end or administrator page you want
visitors to see. The [Weblinks recipe](../deploys/weblinks.json) shows a
working combination of package and landing page. Set `prebuild` to `true`
at the recipe root to prepare and verify a site snapshot during the build.
See the [deployment guide](../deploys/README.md) for variants, CLI commands,
languages, sample content, menu items and templates.

The catalog's `default` is a listed deployment ID. Use `defaultsByJoomla` for
different defaults per Joomla major. To follow an official recipe, include its
entry in your catalog and leave its recipe file upstream. To own it, add the
complete recipe as `site/deploys/<id>.json`. Upstream package refreshes then
apply only to the inherited recipes. Leaving `languages` out of a custom
catalog inherits the upstream language package registry.

## Configure the visitor interface

Set `schemaVersion` to `1` in `site/playground.json`. Omitted features are on.
For a component-only presentation, the following profile hides both bars,
uses the catalog default and fixes PHP at 8.4.

```json
{
  "schemaVersion": 1,
  "features": {
    "header": false,
    "footer": false,
    "settings": false,
    "deployments": false,
    "phpVersion": false
  },
  "defaults": { "phpVersion": "8.4" }
}
```

| Key under `features` | What it controls |
| --- | --- |
| `header` | Top bar and its restore tab. Controls inside the bar also disappear. |
| `footer` | Bottom bar and its restore tab. About moves to an independent button. |
| `focusMode` | Hide/restore chrome controls and focus-mode URL overrides. Use header and footer for permanent visibility decisions. |
| `settings` | Quick settings drawer and its openers. |
| `activity` | Activity dock and technical error details. |
| `autoLaunch` | Automatic launch or resume at startup. Visitors can still launch manually. |
| `launchMedia` | Rocket illustration and playback during startup. |
| `deployments` | Preset selector, deployment editor, and configuration substitution through shared launch links. The catalog supplies the default. |
| `phpVersion` | PHP minor selector and shared-link PHP overrides. Pair with defaults.phpVersion for a fixed minor. |
| `joomlaVersion` | Joomla version selector and shared Joomla version overrides. The recipe must support the selected release. |
| `jcbVersion` | JCB package version selector and shared version overrides. A fork-owned recipe can pin its own installer. |
| `siteLanguage` | Joomla installation language control. Recipe languages still apply. |
| `editor` | JoomEngine Code and its refresh control. |
| `database` | Playground database viewer. Joomla still uses its database. |
| `mail` | Captured-mail viewer and its toolbar control. |
| `phpSettings` | PHP settings dialog and visitor configuration overrides. Set publisher-supplied PHP settings in the recipe. |
| `backups` | Backup creation and the Backups panel. |
| `savedSites` | Legacy saved-site listing and recovery control. This switch does not erase browser storage. |
| `upload` | Upload-site control for importing a portable site. |
| `download` | Site download dialog and backup download actions. |
| `share` | Share dialog and its launcher. |
| `navigation` | Site/Administrator navigation controls around the Joomla frame. |
| `credentials` | Administrator credentials dialog. Configure Joomla accounts and ACL in Joomla itself. |
| `lifecycle` | Reset, restart, close and repair controls. |
| `theme` | Visitor appearance switch. The two brand palettes still apply. |
| `interfaceLanguage` | Playground interface language selector. This is independent of the Joomla site language. |
| `repositoryLinks` | Header Fork and Star links. |
| `guides` | Footer agent and deployment guide links. |
| `credits` | Required. Omitting it or setting it to true keeps About available. Setting it to false fails validation. |

Set any optional feature key to `false` to disable it. Use
`defaults.phpVersion` alone to preselect a supported PHP minor while keeping
the selector available. Use it with `features.phpVersion: false` to fix that
version. Turning off `deployments` uses the catalog's default and prevents
URL parameters from substituting another recipe. These switches control the
Playground interface. Joomla permissions and the public JavaScript API have
their own behavior.

**About and credits** remain accessible when either or both bars are hidden.
Disabling the footer gives visitors a separate About button and moves the
Joomla affiliation and trademark notice into that dialog. The configuration
rejects `"credits": false`. About lists the upstream projects and their licenses.
The distribution includes the original `LICENSE`, `NOTICE` and dependency notices.
Keep About, its links and the notices usable when writing custom CSS. Fork
owners control the source and styles they distribute.

## Change the branding

Set values under `brand` in the site profile. All fields are optional.

| Brand field | Use |
| --- | --- |
| `name`, `title`, `description`, `productLabel` | Product name, page title, page description and short header label. |
| `logo`, `favicon` | A local path such as `assets/logo.svg`. For separate logos use `logo.dark`, `logo.light` and descriptive `logo.alt` text. |
| `footer` | Company notice with optional `prefix`, `company`, `url`, `suffix` and `credit`. This is separate from the About credits. |
| `links` | `repository`, `deploymentGuide` and `agentGuide` URLs. Fork and Star use the configured repository. |
| `colors.dark`, `colors.light` | Maps of theme token names to hex colors, such as `gold`, `focus`, `header-start`, `header-end`, `panel`, `paper` and `ink`. |
| `translations` | Optional localized `name`, `title`, `productLabel` and `footer` text keyed by interface language code, such as `de`. |

For styling beyond colors, point CSS URLs in `site/theme.css` at paths
relative to that file. For example, `url("./assets/pattern.svg")` refers to
`site/assets/pattern.svg`.

## Hosting and updates

After the official Pages deployment passes its publication check, JoomEngine
publishes its tested distribution as `engine-<build-id>.tar.gz` and a matching
`.sha256` file together on an immutable [engine prerelease](https://github.com/joomengine/playground/releases) tagged `playground-engine-v1-<build-id>`.
The first fork build requires this publication to finish.

The fork reads the official build ID, downloads its archive, and verifies
the archive checksum and file inventory. This gives it the compiled WebAssembly
runtime, Joomla packages and version catalog from that build. A matching
prepared deployment reuses its verified upstream snapshot. For a new or
changed recipe with `prebuild: true`, the fork prepares and verifies its
own snapshot. Visitors load the finished distribution from the fork's site.

Automatic runs skip publication when both the upstream build ID and fork
commit match the last deployment. A manual run rebuilds on demand. A failed
check during assembly leaves the previous site serving. The workflow only
publishes build outputs to Pages and leaves the fork's source history alone.

The fork workflow checks out the build tools for the selected upstream
publication and loads your fork's `site/` from its own checkout. If you
also maintain changes to the engine code outside `site/`, use the
[source build](../README.md#build-and-run-locally) to publish those changes.
Workflow changes themselves can be brought into the fork through a normal
GitHub fork sync.

Pages supplies the public URL automatically. For another HTTPS address,
set the top-level `publicUrl` to the actual base URL, including any project
subpath. For a custom Pages domain, also configure it in the fork's Pages
settings and point its DNS at GitHub Pages. Other static hosts can serve the
generated `dist/` directory using the [hosting instructions](../README.md#hosting-and-github-pages).

## File names, precedence and deployment recipes

Start at the root of the fork. The example directory is a template; the build reads the tracked directory named exactly `site/`. The following is its complete input layout for the Field Notes example, with the optional stylesheet shown as well.

```text
site/
  playground.json
  theme.css
  assets/
    field-notes.svg
  deploys/
    catalog.json
    field-notes.json
```

All of these inputs are optional. A branding-only fork needs no deployment files. A recipe-only fork needs no site profile. JSON files use ordinary JSON syntax, including quoted keys and real booleans. Use regular files inside the directory. Symlinks fail validation. Treat these files, including all copied assets, as public.

| Desired result | What to commit |
| --- | --- |
| Follow the complete official preset list and all recipe updates | Omit `site/deploys/`. |
| Change one official recipe and follow the rest | Copy that recipe from `deploys/` into `site/deploys/` under its original filename. Edit the local copy. Leave the catalog absent. |
| Show only selected official presets | Write a local catalog listing their descriptors. Omit their local recipe files. Newly introduced official presets stay out of this menu. |
| Mix an inherited preset and an independent recipe | List both in the local catalog. Supply a local JSON recipe only for the one the fork owns. |
| Restore upstream behavior | Remove the corresponding local override and rebuild. For a local-only recipe, remove its catalog entry too and choose a valid remaining default. |

The catalog requires `schemaVersion: 1`, a `default` ID and an ordered `deploys` array containing 1–100 distinct entries. Use 1–64 lowercase ASCII letters, digits or hyphens for each ID, beginning with a letter or digit. Three values must agree. For ID `field-notes`, the descriptor has `"file": "./field-notes.json"`, the file is named `field-notes.json`, and its root contains `"id": "field-notes"`. Adding a file alone does not add it to the menu. Catalog titles and descriptions label the menu; use consistent wording in the recipe and its descriptor. A local catalog owns its ordering and per-major defaults. Its optional `languages` registry replaces the inherited registry as a whole.

To **own an extension deployment**, use the [complete Field Notes recipe](../examples/fork-site/deploys/field-notes.json) for an independent site, or copy the [Weblinks recipe](../deploys/weblinks.json) for a site with a packaged extension. Put the released HTTPS ZIP URL and its SHA-256 in the extension entry; obtain the digest from the actual installer with `sha256sum`. Update the URL and digest together when releasing your next version. Set `initialPath` to the Joomla route you want visitors to open. A fork that pins JCB can retain its own package version and checksum while the official catalog advances.

| Recipe field | Role |
| --- | --- |
| `schemaVersion`, `id`, `title`, `description` | Format version, stable identity, human-readable name and optional explanatory text. |
| `joomla`, `requirements` | Supported Joomla majors and constraints such as PHP compatibility, JCB requirements and major-version fallbacks. |
| `configuration` | Shared installation settings. Supply the site name and landing route, packages, startup commands, languages, content, menus, template, overlays and PHP settings as needed. |
| `variants` | Joomla-major-specific configuration. Put settings or packages that differ between Joomla releases under their major key. |
| `prebuild`, `snapshot` | Request a prepared copy or declare a compatible existing snapshot. The builder generates snapshot references for prepared recipes. |

The [catalog schema](../deploys/catalog.schema.json) and [recipe schema](../deploys/schema.json) give the exact nested properties, types and allowed values. The [deployment guide](../deploys/README.md) covers command arguments, language tags, menus, templates, content and snapshot semantics. The [deployment document schema](../deploys/document.schema.json) describes the separate format used by the visitor editor for import and sharing. Start a repository recipe from the recipe schema.

## Exact site-profile and branding conventions

The supported top-level keys in `site/playground.json` are `schemaVersion`, `publicUrl`, `brand`, `features` and `defaults`. Use schema version 1. Unknown profile keys and unknown feature names fail the build. Each optional feature takes a JSON boolean. The supported key under `defaults` is `phpVersion`, a **string** such as `"8.4"`. Choose a minor shipped by the engine and compatible with the default deployment. Joomla-major defaults belong in the deployment catalog.

- **Identity.** Setting `brand.name` without a logo produces a text wordmark. The title falls back to the name; set `brand.title` for a different browser-tab title. Set `productLabel` for the short label beside the wordmark and `description` for the HTML description.
- **Images.** A single logo string works for both themes. In the object form, a single supplied light or dark asset also covers both themes. Image paths start with `assets/`, relative to `site/`; match filename case exactly. Supported extensions are `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif` and `.ico`. The favicon accepts the same local path convention.
- **Publisher notice.** Providing `brand.footer` replaces the publisher line with the supplied fields in the order `prefix`, `company`, `suffix`, `credit`. Supply `company` when using `url`. The independent Joomla affiliation, project list and license notices remain available.
- **Links.** Use absolute HTTP or HTTPS links without embedded credentials. Set `links.repository` to the repository home page; the fork link adds `/fork`. Set either guide URL independently.
- **Translations.** Use a base value for every field you translate. Language-specific values may replace `name`, `title`, `productLabel` and any footer text field. Assets and URLs are shared. Supported keys are `en`, `af`, `de`, `fr`, `it`, `es`, `zh-CN`, `nl`, `he`, `el`, `ar`, `pt`, `ru`, `ja`, `ko`, `hi`, `bn`, `tr`, `id` and `uk`.
- **Colors.** Each light/dark map accepts the following keys without the CSS `--` prefix. Values use hex notation with 3, 4, 6 or 8 digits after `#`. Omitted tokens inherit the engine theme. The custom stylesheet loads after the core and generated brand styles.

| Theme area | Supported tokens |
| --- | --- |
| Surfaces and text | `canvas`, `ink`, `muted`, `line`, `panel`, `paper`, `shadow` |
| Accents and feedback | `gold`, `gold-bright`, `focus`, `danger`, `error-bg`, `success` |
| Controls | `control`, `control-border`, `hover`, `code-border`, `button-bg`, `button-hover`, `button-ink` |
| Shell and launch scene | `header-start`, `header-end`, `footer-start`, `footer-end`, `scene-start`, `scene-end`, `scene-glow` |

For example, this complete profile changes the publisher line, translates its credit and overrides just one color in each theme. It can be used without any local images or recipes.

```json
{
  "schemaVersion": 1,
  "brand": {
    "name": "Field Notes",
    "footer": { "company": "Field Notes", "credit": "Community edition" },
    "translations": { "de": { "footer": { "credit": "Gemeinschaftsausgabe" } } },
    "colors": { "dark": { "focus": "#9ae4cc" }, "light": { "focus": "#16634f" } }
  }
}
```

## Verify and troubleshoot a fork

From the repository root, the following checks exercise the configuration reader, fork composition, brand rendering, deployment staging and engine archive verification. They use local fixtures and do not publish anything.

```sh
npm ci --ignore-scripts
node --test test/site-build.test.mjs test/site-brand.test.mjs test/deploy-build.test.mjs test/fork-engine.test.mjs
```

To verify **your own site**, run the fork workflow with your tracked files. Inspect the selected preset, PHP version and landing route in a fresh browser session. Switch between light and dark themes, change the interface language, and open About. For a fixed-deployment site, open a link requesting a different preset and confirm that the site still offers its configured default. Verify an existing saved site separately from a fresh launch.

| Symptom | Where to look |
| --- | --- |
| Official appearance or preset list appears | Check that the files are committed on the branch being published and that the path is `site/playground.json` or `site/deploys/catalog.json`. Editing only `examples/` leaves the live inputs untouched. |
| Missing recipe, identity mismatch or incompatible runtime | Compare the descriptor ID, filename, recipe ID, per-major defaults and requirements with the available Joomla/PHP pairs. |
| Package verification fails | Check the release ZIP and compute its digest again. A replacement ZIP at an old URL needs its own reviewed hash. |
| Image works locally but disappears on Pages | Verify exact case, the tracked asset path, the page’s project subpath and the separate light-mode logo. Use relative asset references. |
| Fork workflow skips or no scheduled publication runs | Check the repository variable, workflow enablement, default branch and Pages source. Use manual dispatch to force a build. Automatic checks skip an already-published source commit and engine build ID. |
| Engine archive unavailable | Check the official Pages run and its downstream-engine publication job. The official site can be live before the matching archive finishes uploading. Run the fork workflow again once the release asset is available. |
| A site customization must be reverted | Revert its configuration commit in the fork and republish. Automatic mode follows the currently published upstream engine; reverting a site commit rolls back the site inputs. |

### Discovery for agents and maintainers

For a request to “brand”, “white-label”, “customize a fork” or “build an extension demo”, inspect the fork's existing `site/` first. Change the smallest applicable input from the ownership table. Preserve its other recipes and settings. Read the matching source schema before producing nested deployment JSON. Keep build outputs under `dist/` generated. Published profiles are public; keep credentials out of the site directory.

For implementation-level questions, the [site build](../scripts/site-build.mjs) resolves the profile and deployment URL, [recipe staging](../scripts/deploys.mjs) selects and verifies packages, the [brand renderer](../scripts/site-brand.mjs) validates publisher fields, and the [feature registry](../src/site-features.mjs) defines optional and required controls. The [fork workflow](../.github/workflows/fork-pages.yml) specifies triggers and publication permissions. When adding a future required action, register it as required and give visitors an accessible entry point even when both bars are hidden. The About control demonstrates that pattern.
