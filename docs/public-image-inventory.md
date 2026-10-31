# Approved public images

The relay permission list is `config/public-assets.json`, version
`jcb-2026-10-31-v1`. It contains **31 exact raster-image URLs**, taken from the
`dynamicContent` metadata in the installed Joomla Component Builder 5.2.0 and
6.2.0 packages. Both installed helpers contain the same URL/MD5 pairs. Component
metadata, user deployments and extension updates cannot extend this list.

The sources reviewed were the playground's existing built snapshots:

| Installed site | Snapshot SHA-256 |
| --- | --- |
| Joomla 5.4.10 / JCB 5.2.0 | `937ef8ae3b929755008b50add14369b5cad7f69f5f47b917d5662565ee43dc74` |
| Joomla 6.2.0 / JCB 6.2.0 | `bc729fd768d9f8086fdf492b41e6664f1d9289a8615950d11302a51cb9b09bdb` |

The canonical source member is
`administrator/components/com_componentbuilder/src/Helper/ComponentbuilderHelper.php`.
The snapshot identifiers above identify the package artifacts; use the inventory
script's emitted digest to verify the actual ZIP being inspected. The related
package archive pins are retained in `deploys/jcb.json`.

| Approved use | Entries | Format | Original source |
| --- | ---: | --- | --- |
| Joomla heart banners (wide/tall) | 2 | GIF | Exact `vdm-io/jcb-external` URLs in registry |
| Joomla Community Magazine banner | 1 | PNG | Exact `JCM_2010_120x600.png` URL in registry |
| TLWebdesign sponsor banner | 1 | PNG | Exact metadata URL in registry |
| VDM sponsor banner | 1 | GIF | Exact metadata URL in registry |
| Agerix sponsor banner | 1 | GIF | Exact `cms-experts.org` metadata URL in registry |
| Compiler particle animations 1–24 | 24 | GIF | 24 separately approved URLs; no numeric wildcard |
| Original compiler animation | 1 | GIF | Exact `joomlacomponentbuilder.com` metadata URL in registry |

All entries reject redirects and extra query parameters. Each has an 8 MiB
response ceiling, the original JCB MD5, and a 15-minute revalidation policy.
The ceiling is a resource limit, not a statement that every upstream download
has been measured. These URLs are mutable upstream paths. They are **not**
advertised as immutable, and an upstream change that no longer matches the
recorded JCB checksum fails until a reviewed registry/package update is made.
JCB's existing checksum verification remains active after the relay check.

The inventory also found references that are deliberately **not approved**:

| Reference | Reason |
| --- | --- |
| Four SVG support badges from shields.io/OpenCollective | Runtime SVG relay is excluded. They remain subject to ordinary browser policy; no replacement artwork is supplied. |
| `are-we-online.gif` heartbeat with a generated query | Connectivity telemetry, not an approved public-content image. |
| Vue developer-tools favicon string | Development tooling reference; not a supported Joomla/JCB content image. |
| New images in installed/imported extensions | Require a deliberate registry review; package metadata is not a permission source. |

Reproduce the source inventory with:

```bash
node scripts/inventory-public-assets.mjs dist/assets/snapshots/jcb-*.zip
```

This command produces review candidates only. It does not write the permission
registry. Static references are not proof that every conditional JCB screen has
requested them; browser evidence must identify the paths actually exercised.

`test/public-assets.browser.mjs` checks actual WebKit/Chromium/Firefox resource
handling against a fixture HTTPS image host with neither CORS nor CORP. It first
proves that `require-corp` blocks the original image, then exercises approved
`src`, `srcset`, `picture`, CSS backgrounds and dynamic images through the service
worker. It also checks the PHP Fetch adapter's exact response bytes, normal-mode
zero-relay behavior and bounded relay failure. This transport test does not by
itself certify every Joomla/JCB screen or a physical iOS device.

The integration does not rewrite Joomla HTML, stylesheets, metadata or saved
database records. Approved image requests are intercepted before the original
network request. The PHP Fetch adapter resolves only anonymous GET/HEAD reads
of exact approved URLs, outside the virtual PHP route; API calls, credentials,
unapproved headers and other URLs retain the existing transport. The existing
JCB fallback still emits its original remote URL, which follows that same
approved browser path under the confirmed compatibility policy. Cache filenames,
image-format guards and verified-cache logic are unchanged.
