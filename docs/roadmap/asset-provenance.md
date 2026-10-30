# Supplied icon provenance

Source: user-provided `black-svg-icons.zip`.

SHA-256: `d43881529b5e9c618faeaeec097af18ec62588be99989f920963c29308df05f6`.

The archive contains 2,785 unique SVG files, 18 directories and no other files. Selected originals are preserved byte-for-byte under `originals/`. Exact paths and hashes are in `icon-manifest.json`. All 79 selected monochrome sources use a 24×24 viewBox. The package assigns 103 application actions; aliases intentionally reuse original symbols.

Only a root SVG fill is added for black, white or currentColor output. Path geometry, groups, winding rules, viewBox and fill=none remain unchanged. No custom replacement icon artwork has been created.

No source license or release identifier was supplied. This package does not assert a license. Confirm the applicable original release and retain its attribution/notices before distributing the application.

The brand rocket is a second user-supplied source: `JoomEngine_Pearl_Logo.svg` (218,076 bytes). Its exact original and SHA-256 are preserved under `brand/`. It is not part of the monochrome archive. Its derivatives preserve paths, gradients, colors and transparency, changing only root dimensions/framing.

## Implementation verification — 30 October 2026

Every one of the 79 selected monochrome originals matches the official Remix Icon
v2.5.0 release byte-for-byte at commit
`755818100db4687fd907ecaef9f57cc9ea77d0d8`. That release's Apache-2.0 license is
preserved verbatim in `src/brand/icons/LICENSE.remixicon.txt`; per-file verification
and hashes are in `src/brand/icons/upstream-verification.json`. This establishes a
specific upstream source and license without inferring them from filenames.

The pearl rocket master remains unchanged (SHA-256
`55305a0c163c69a1ca851adfcb0139449cd5658dfbb126e090da3e024abb98ca`).
`scripts/build-brand.mjs` derives the UI and favicon files by framing and whitespace
minification only; paths, gradients and colors remain exact. Inkscape raster proofs
at 16, 20, 24, 32, 48 and 64 pixels on both shell backgrounds were visually checked
for complete silhouette, flame and uncut edges. These asset checks do not substitute
for browser favicon or application layout checks.
