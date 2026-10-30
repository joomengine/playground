# JoomEngine Code identity

Use **JoomEngine Code** in normal text and **JOOMENGINE CODE** in the wordmark. The launcher and its tooltip are **Open JoomEngine Code**. Use **JEC** only when a compact control cannot accommodate the full name; its accessible name still uses the full name.

## Vector assets

| Asset | Intended background | Use |
| --- | --- | --- |
| `src/brand/joomengine-code-dark.svg` | Dark, including Playground navy `#080a27` | Full wordmark; welcome, About, editor title |
| `src/brand/joomengine-code-light.svg` | White or pale neutral | Full wordmark on light surfaces |
| `src/brand/joomengine-code-compact-dark.svg` | Dark | Compact JEC launcher or constrained title |
| `src/brand/joomengine-code-compact-light.svg` | Light | Compact JEC launcher or constrained title |

The full artwork is suitable from 240 CSS pixels wide upwards. Use the compact artwork from 42 pixels wide when space is limited, or ordinary text at smaller sizes. Each SVG scales without a bitmap, external font, script, or network resource. Preserve the aspect ratio and leave at least half the letter height clear around it. Do not crop the glare, stretch letters, or apply a CSS colour filter. The small mark omits the soft flare and fine highlight so its letter shapes remain clear.

The dark version uses the existing silver/white `#edf0ff`, navy and warm gold `#ffc55b` palette. The light version uses navy `#20264a` with a darker gold accent for contrast. CODE uses the same stroke weight, rounded rectangular O, angular M/N and squared E as JOOMENGINE; a small gold highlight sits on C. The logo conveys a name, so functional controls also need a visible focus ring and a readable text label or tooltip.

The repository's original `src/brand/joomengine-logo.webp` is a 400 × 80 raster. No original outline or font source accompanies it. These new SVG paths are a documented geometric reconstruction of that existing identity, extended with CODE, rather than a claim to be the original designer's font outlines. They require no additional font licence. The original logo is retained.

The Playground header uses that original WebP in dark mode. Its light-mode companion, `src/brand/joomengine-logo-light.svg`, uses the ten JOOMENGINE glyphs from the existing Code vector artwork in solid black, centered in the same 400 × 80 transparent canvas. Both glare effects are removed, as requested on 31 October 2026. It contains no embedded bitmap, gradients, filters or background plate. These are the documented geometric brand outlines above, not outlines recovered from the original raster. Regenerate it with `node scripts/build-wordmark.mjs` after changing the Code vector lettering.

## Accessible integration

For a launcher use a button with `aria-label="Open JoomEngine Code"` and `title="Open JoomEngine Code"`. Set the image inside it to `alt=""` to avoid repeating the button name. A standalone image uses `alt="JoomEngine Code"`. Each SVG also contains a title and description for direct embedding. The detached document title and workbench name remain `JoomEngine Code`.

All four variants were rendered in Chromium on dark and light surfaces at both large and small sizes. This checks clipping, stroke rendering, transparency and legibility; visual comparison with the original remains a design review rather than a pixel-identical reconstruction assertion.

## Recognition

The Code About view extends the existing recognition rather than replacing it. It should credit Microsoft VS Code and Monaco; CodinGame's Monaco VS Code integration; PHP and phpdbg; Sean Morris and the PHP-WASM contributors; Emscripten; the bundled language-service, grammar, icon and theme contributors; and the actual dependencies in `assets/code/dependencies.json`.

Link to `assets/code/dependencies.json` for exact installed versions, package integrity and notice locations, and to `assets/code/notices/source/provenance.json` for upstream material already compiled into the CodinGame packages. Preserve `NOTICE` and all copied licence files in the distribution. jschardet is LGPL-2.1-or-later; its notice and corresponding source must remain available. An About credit does not replace distribution notices or source obligations. See `dependencies/joomengine-code/README.md`.
