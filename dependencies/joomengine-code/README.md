# JoomEngine Code distribution notices

These files restore upstream notices missing from the published CodinGame npm packages. `provenance.json` records exact source revisions, embedded package versions, archive integrity and SHA-256 digests of the preserved notices. The build copies this directory into `assets/code/notices/source/` and links it from the editor dependency manifest.

## Components and sources

| Component | Exact version or source | Licence / recognition |
| --- | --- | --- |
| CodinGame Monaco VS Code integration, services and default extensions | 38.1.3; source `010c84da9caff452b81db844b647b6ab749af012` | MIT; copyright CodinGame |
| Microsoft Visual Studio Code | 1.142.0; source `d956e8a6ac5d904486557eea07e1d6bd62a4d36f` | MIT plus the preserved complete third-party notices |
| Microsoft Monaco Editor | 0.57.0; source `d61824269f1377111d34306e4a47172327777083` | MIT plus the preserved complete third-party notices |
| vscode-textmate | 9.3.2, embedded by CodinGame | MIT; Microsoft and contributors |
| vscode-oniguruma | 1.7.0, embedded by CodinGame | MIT; Microsoft; its `NOTICES` also preserves Oniguruma's BSD terms and copyright |
| Codicons | 0.0.46-48, embedded by CodinGame | CC-BY-4.0 artwork and MIT code; Microsoft and contributors |
| jschardet | 3.1.4 | LGPL-2.1-or-later; António Afonso and contributors; Mozilla/Netscape detector origins |

The upstream CodinGame `package.json` identifies VS Code and Monaco; its `package-lock.json` identifies the embedded npm packages. The copied Oniguruma WebAssembly module and Codicons font were compared byte-for-byte with the integrity-verified npm archives. The original font and engine are unmodified. TextMate code is transformed by CodinGame's build; its version follows that same pinned upstream lockfile.

VS Code's complete notices retain attribution for the bundled PHP, JavaScript/TypeScript, HTML, CSS/SCSS/LESS, JSON, XML, INI, YAML, SQL, Markdown and shell grammars, default themes and Jesse Weed's Seti icon artwork. This complete upstream notice collection also mentions components not selected by this browser integration; inclusion of a notice does not claim that every upstream component is shipped. `assets/code/dependencies.json` is the generated inventory of packages actually used by the editor build, including any additional language services. It records their exact versions, declared licences, npm integrity and copied notices. Do not remove licence files just because the overall package declares MIT.

The PHP runtime, phpdbg, PHP-WASM adapters and Emscripten are recognized in the project's `NOTICE` and About view; their build-specific notices and provenance remain with the existing runtime assets rather than being replaced by this editor inventory.

## Decoder adaptation

`scripts/code-assets.mjs` applies a narrow transformation to the pinned VS Code `encoding.js` while bundling. It replaces the permissive Unicode decoder with `src/code/encoding-guard.mjs` so malformed UTF-8/UTF-16 data produces an actionable error rather than editable replacement characters. Legacy encodings retain their upstream iconv handling. The original decoder statement is asserted before transformation, the package files are unchanged, and `provenance.json` records the source file digest and implementation paths. This adaptation retains the original MIT notices.

## jschardet source and replacement

The distribution includes the complete installed `jschardet` 3.1.4 npm package in `assets/code/notices/source/jschardet/`, including its preferred-form `src/`, entry points, build scripts, contributors, package metadata and LGPL licence. Its source is unmodified. The verified npm archive URL and integrity are recorded in `provenance.json` and the project's `package-lock.json`.

The browser loads this library through the separate `assets/code/jschardet.js` module. It is intentionally replaceable without changing the workbench chunks. The adapter exports `detect`, `detectAll`, `UniversalDetector` and `enableDebug`, and a default export containing those members. To use a modified library, edit its source, bundle the adapter as ESM, and replace `assets/code/jschardet.js` in a locally served distribution. Keep those interface-compatible exports. Reload the editor with the replacement asset and clear any old site asset cache. The repository's `scripts/code-assets.mjs` contains the exact adapter and bundler settings used for the distributed module; the pinned esbuild version is in `package-lock.json`.

You may modify the work for your own use and reverse engineer it to debug those modifications. These rights are not restricted by this project's terms. If redistributing modified library sources, preserve the LGPL licence and original notices and identify your changes. The separately distributed source and replacement mechanism accompany the prominent notice in `NOTICE` and About; credit alone is not the source distribution mechanism.

## Updating

When changing CodinGame, fetch the notices from the precise new source revisions and re-check embedded dependency versions against its lockfile. Verify archive integrity, compare copied binary assets, update the hashes in `provenance.json`, and retain package-level notices. Build validation must reject a CodinGame version that has no matching notice provenance.
