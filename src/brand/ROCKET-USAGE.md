# JoomEngine pearl rocket — authoritative brand asset

The user supplied `JoomEngine_Pearl_Logo.svg` as the replacement rocket across the project. This supersedes both the existing branded rocket and the generic rocket from the monochrome icon bundle. It applies to the favicon, Deployment, Launch and other branded rocket uses. Keep the separate JoomEngine wordmark where appropriate.

## Included files

- `JoomEngine_Pearl_Logo.original.svg`: exact uploaded master, 218,076 bytes, 1280×1280 intrinsic canvas.
- `rocket.svg`: the same vector artwork, centered in a padded square frame with a convenient 24×24 intrinsic size for UI use.
- `favicon.svg`: the same framing/artwork with a 32×32 intrinsic size for a scalable favicon.
- `brand-manifest.json`: original hash, measured drawing bounds and normalized viewBox.

The derivatives change only root dimensions, viewBox and preserveAspectRatio. Paths, gradients, colors, lettering, flame and transparency remain intact. The normalized frame uses the measured artwork center and adds 2.5% of its longest dimension on each edge. This is a conservative starting frame; optical adjustments may be made and visually checked during application integration.

## Usage

Use this rocket in full color on both light and dark backgrounds. Do not pass it through the action-icon black/white/currentColor conversion. Its gradients are part of the supplied identity.

An external `<img src="…/rocket.svg" width="24" height="24" alt="">` inside a correctly labelled button avoids repeating its many gradient definitions. Keep CSS `object-fit: contain`, a deliberate icon box, and no fixed 1280px layout dimensions. Set the button's accessible label independently.

Use a `rel="icon"` link with SVG MIME type and `sizes="any"` for the vector favicon, subject to the project's browser support. Replace old rocket references and update existing manifest/touch/fallback assets where present. Render fallback PNG/ICO sizes from this same master when needed; do not replace the primary vector with a raster.

If inline copies are necessary, scope every gradient/clip/title ID and reference per instance, or use a correctly configured shared symbol. Copying the entire SVG repeatedly with duplicate IDs can break gradients in a document.

## Size and optimization checks

Check real 16, 20, 24, 32, 48 and 64px rendering on both backgrounds, plus high-DPI displays. Fine lettering and reflections will naturally disappear at favicon size; prioritize the recognizable complete rocket. Do not invent a simplified replacement or remove details without review.

Cropping/reframing should remove unused canvas, not cut off the flame or body. Preserve aspect ratio and leave small optical padding. Tune placement within the icon box independently from button layout. The preview sheet shows the proposed framing, not a final browser favicon certification.

Changing SVG width/height does not reduce file payload. Keep the master intact and use conservative, reproducible minification/optimization for deployed files, followed by a visual comparison. Preserve gradients, clipping and transparency. Cached external use avoids copying the 218KB markup into every toolbar button.

No application references have been changed by this handoff. Application integration, optimization and real browser favicon/cache checks are explicitly included in the implementation roadmap.
