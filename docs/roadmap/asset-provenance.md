# Icon and brand provenance

The monochrome action icons are [Remix Icon](https://github.com/Remix-Design/RemixIcon), copyright Remix Design, from the Apache-2.0-licensed [v2.5.0 release](https://github.com/Remix-Design/RemixIcon/tree/755818100db4687fd907ecaef9f57cc9ea77d0d8).

The selected originals are preserved byte-for-byte in `src/brand/icons/originals/`. The release license is preserved verbatim in `src/brand/icons/LICENSE.remixicon.txt`; per-file verification and hashes are in `src/brand/icons/upstream-verification.json`. Exact source paths and application mappings are recorded in `src/brand/icons/icon-manifest.json`. Aliases intentionally reuse original symbols.

Theme variants add only root SVG paint and accessibility metadata. Path geometry, groups, winding rules, viewBox and `fill="none"` remain unchanged.

The JoomEngine pearl rocket is separate project brand artwork. Its master remains unchanged (SHA-256 `55305a0c163c69a1ca851adfcb0139449cd5658dfbb126e090da3e024abb98ca`). `scripts/build-brand.mjs` derives the UI and favicon files by framing and whitespace minification only; paths, gradients and colors remain exact.

The original framing validation checked Inkscape raster proofs at 16, 20, 24, 32, 48 and 64 pixels on both shell backgrounds for complete silhouette, flame and uncut edges. Those asset checks do not substitute for browser favicon or application layout checks.
