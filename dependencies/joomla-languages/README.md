# Joomla language packages

The language catalogue uses the official Joomla translation sources at the
commit and archive digest recorded in `packages.json`. Each language remains a
separate ZIP: an English installation downloads none, while a multilingual
deployment downloads only its selected languages. They are never embedded in
PHP, preloaded into the runtime, or installed by the interface language selector.

The build assembles installable packages from the upstream
`joomla_v{major}/translations/package/{tag}` directories. It retains their
translations, manifests, localise classes, notices and update-server identities.
Only empty XML version/date placeholders are completed, following the upstream
package-builder convention. A `.0` package revision identifies a locally assembled
version where the source has no release version; it is not represented as an
official published language-pack release.

When an official manifest requests child ZIPs, the builder assembles them from
the corresponding site, administrator and API directories. The child archives
retain the same source bytes and use the same deterministic ZIP settings; their
source directories and output digests are recorded in the provenance document.

Each resulting archive has a pinned SHA-256 and a generated provenance document
listing every packaged file, its digest, and every placeholder completion. The
archive timestamp and entry ordering are deterministic. These files are served
on the playground origin because browser CORS rules can prevent direct downloads
from the Joomla package host. These staged language packages are installed from
the Playground origin at runtime.

The sources are maintained by the Joomla translation teams and licensed under
GNU GPL version 2 or later, as declared by their package manifests. The source
repository and exact commit remain recorded with every generated package.

Afrikaans is first and default only in multilingual deployments. Ordinary
deployments retain Joomla's English default. Rocket's interface language is a
separate preference and never changes Joomla or installs a language pack.
