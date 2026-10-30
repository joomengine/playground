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

## Subsequent real-browser evidence

The earlier managed-preview limitation above does not apply to the supported build exercised in GitHub Actions. [Run 66](https://github.com/joomengine/playground/actions/runs/41095978456) at `439bf9c` passed both Chromium and Firefox Rocket/chrome suites. The [Chromium artifact](https://github.com/joomengine/playground/actions/runs/41095978456/artifacts/12997028367) and [Firefox artifact](https://github.com/joomengine/playground/actions/runs/41095978456/artifacts/12997496944) contain real running-Joomla screenshots and receipts.

Reviewed captures cover wide/narrow dashboard, About and footer in Light/Dark themes; keyboard-visible focus; hidden chrome in the middle of the document; top/bottom restoration; RTL; and reduced motion. Assertions also verify unchanged iframe/document/form state and no replacement workers, full-color 24-pixel controls, decoded/versioned SVG favicon, live System theme changes and manual overrides.

Native editor/AI interaction evidence from the Chromium and Firefox jobs covers compact/narrow controls, detached Light/Dark windows, return/redock, tab/split continuity, keyboard scrolling and undo. These are actual native editor captures; the original `ui-fixture-*` images remain explicitly limited shell fixtures.

The [live PR checklist](https://github.com/joomengine/playground/pull/8#issuecomment-6526041362) records the latest full-matrix result and any later fixes. Neither screenshots nor automated focus assertions claim manual screen-reader, physical touch, or native browser 200% zoom acceptance.
