# Publish a Playground for your extension

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
`.sha256` file on the [dedicated engine prerelease](https://github.com/joomengine/playground/releases/tag/playground-engine-v1).
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
