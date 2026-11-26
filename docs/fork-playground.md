# Publish a Playground for your extension

A fork can launch visitors straight into its own Joomla component, with its own
deployment choices, branding and tools. Keep these files in a tracked `site/`
directory. The official JoomEngine build supplies the browser runtime and its
verified Joomla and PHP versions.

## Publish the working example

1. Fork this repository. In the fork, enable GitHub Actions and select **Settings → Pages → Build and deployment → Source → GitHub Actions**.
2. From a local checkout of the fork, copy the example into a new `site/` directory and commit it to the default branch.

   ```sh
   cp -R examples/fork-site site
   git add site
   git commit -m "Set up the Field Notes Playground"
   git push
   ```

3. Open **Actions → Publish fork playground → Run workflow** on the default branch. Open the Pages URL from the deployment when the run finishes. GitHub Pages can serve the fork at its ordinary project URL, including the repository path.
4. For automatic updates, set the repository Actions variable `PLAYGROUND_FORK_PAGES` to `true` under **Settings → Secrets and variables → Actions → Variables**. The fork checks for upstream publications every four hours and builds changes to `site/` on the default branch. Pull requests that change the site are validated before publication.

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

| Feature keys | Visitor controls |
| --- | --- |
| `header`, `footer`, `focusMode`, `settings`, `activity` | Top bar, bottom bar, hide/restore controls, settings drawer and activity display. |
| `autoLaunch`, `launchMedia` | Automatic launch and splash-screen imagery. |
| `deployments`, `phpVersion`, `joomlaVersion`, `jcbVersion`, `siteLanguage` | Deployment selection and editing, runtime and JCB selectors, Joomla site language. |
| `editor`, `database`, `mail`, `phpSettings` | JoomEngine Code, database viewer, mail viewer and PHP configuration controls. |
| `backups`, `savedSites`, `upload`, `download`, `share` | Backups, saved-site controls, site import, site export and sharing. |
| `navigation`, `credentials`, `lifecycle` | Site navigation, administrator login details and site lifecycle controls. |
| `theme`, `interfaceLanguage`, `repositoryLinks`, `guides` | Appearance switch, interface language, project links and guide links. |

Set any of these feature keys to `false` to disable it. Use
`defaults.phpVersion` alone to preselect a supported PHP minor while keeping
the selector available. Use it with `features.phpVersion: false` to fix that
version. Turning off `deployments` uses the catalog's default and prevents
URL parameters from substituting another recipe. These switches control the
Playground interface. Joomla permissions and the public JavaScript API have
their own behavior.

**About and credits** remain accessible when either or both bars are hidden.
The supported profile rejects `"credits": false`. JoomEngine maintains these
protected controls, the component credits, the distributed `LICENSE` and
`NOTICE`. A fork owner still controls the source code they distribute.

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

The fork fetches the official published distribution, verifies the files
against its inventory and applies the local `site/` configuration. This
reuses the WebAssembly runtime, Joomla packages and version catalog from an
upstream publication. The fork prepares its selected deployment recipes and
publishes the assembled files under its own Pages address. Visitors load the
runtime from the fork's site. Routine publications do not write back to the
fork's source branch.

The workflow compares the upstream build ID and the fork's source commit
with its last publication. A new upstream publication can change the runtime even when the Git source commit
stays the same. A logo or recipe change can publish a new fork build using
the same upstream runtime. A failure while preparing a candidate stops
publication of that candidate. The first fork build requires an official
publication that includes the engine build identifier.

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
