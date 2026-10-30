# Visual review evidence

Captured 30 October 2026 from the implementation branch.

- `pearl-rocket-size-proof.png`: real SVG rasterization at 16, 20, 24, 32, 48 and 64 pixels, enlarged for comparison, on the actual light and dark palette backgrounds. Complete body/flame and transparency were inspected. This is asset rendering evidence, not browser favicon-cache validation.
- `about-dark-actual-shell.jpg`: the real application About dialog, including the required technology order and repository links. The real shell's appearance selector works even when runtime setup fails.
- `ui-fixture-wide-light.jpg`, `ui-fixture-wide-dark.jpg`, `ui-fixture-narrow-light.jpg`, `ui-fixture-narrow-dark.jpg`: explicitly labeled UI-only fixtures using the current `index.html`, real source CSS/icon/theme/language modules, and the production runtime/deployment catalogs. The narrow frame is 390 pixels wide (375 content pixels plus scrollbar); document width equals scroll width, with no horizontal overflow.
- `ui-fixture-language-menu.jpg`: the shared language selector shows real catalog tags and names on open. Typing `French`, pressing ArrowDown then Enter selected `fr-FR` in the actual selector module.
- `shell-preview-limited.jpg`: the real shell's runtime setup limitation on the managed preview host, retained for transparency.

## What the screenshots do not prove

The managed preview URL is HTTP on `terminal.local`, which the browser does not treat as a secure context. The real application's HTTPS/service-worker/isolation check therefore stops runtime initialization. That check was not bypassed or weakened. Separate scratch-only fixture pages omit runtime startup, clearly label themselves, and do not claim a Joomla/PHP/MariaDB launch.

These images verify icons, palette, dashboard layout, language-control rendering and About content. They do not establish storage migration/deletion, a running Joomla route switch, native Code detachment, live provider access, HTTPS local-server permissions, or runtime accessibility behavior. Those require the full supported build and browser suites plus authenticated provider smoke tests described in the roadmap.
