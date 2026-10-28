# JCB spreadsheet platform build

The official JCB 5.2.0 and 6.2.0 packages bundle PhpSpreadsheet 1.29.2 with ZipStream 3.1.0, whose declared PHP platform requires 64-bit integers. The upstream PHP WebAssembly runtime uses 32-bit integers. This build composes the supported PhpSpreadsheet 3.10.8 release with its supported ZipStream 2.4.0 dependency for the actual browser platform.

`composer.json` targets PHP 8.3.11 with `php-64bit: false`. The same locked libraries support PHP 8.3, 8.4 and 8.5. Composer generates its normal PHP and extension checks; those checks remain enabled in the installed library. PhpSpreadsheet's native ZipStream 2 adapter handles archive writing. The build does not change Joomla core or the PHP runtime to accommodate this dependency.

JCB's existing `ChunkReadFilter::readCell()` returns booleans but omits the return declaration required by the supported spreadsheet reader interface. The reviewed overlay adds `: bool`. Both original and resulting file hashes are checked by `scripts/jcb-platform-overlay.mjs`; unfamiliar JCB source fails the build. The original copyright and license header are preserved.

`scripts/jcb-vendor-overlay.mjs` also adjusts four reviewed XLS/OLE packing sites in two spreadsheet files. The unsigned constants `0xFFFFFFFF`, `0xFFFFFFFD` and `0xFFFFFFFC` exceed a signed 32-bit PHP integer and trigger float-to-integer conversion warnings on PHP 8.5. Their signed equivalents `-1`, `-3` and `-4` produce the same four bytes with `pack('V', ...)`. A third file, `Shared/IntOrFloat.php`, checks the integer range before casting and preserves out-of-range or nonfinite floating-point values, including empty OLE timestamps and large numeric cells. Exact source and result hashes constrain all three file adjustments. The integration suite checks integer boundaries, nonfinite values, exact packed bytes and a 9.1 MB OLE round trip; warning reporting remains enabled.

## Reproducible inputs

- `composer.json` defines the platform and direct dependency versions.
- `composer.lock` pins every transitive release and source commit. Each distribution entry also includes the checksum of its verified archive.
- `packages.json` records the corresponding archive SHA-256, source URL, commit and license.
- `vendor-inventory.json` pins the size and SHA-256 of every generated vendor file, including Composer's autoloader and platform checks. Unexpected, missing or modified files fail verification.
- Composer 2.10.3 is downloaded from its versioned official URL and verified against its published SHA-256. No global Composer installation is required.

The native build host needs PHP 8.3 CLI with `mbstring`, `xml`, `gd`, `zip` and `curl`, plus the common `ctype`, `fileinfo`, `iconv` and `phar` modules. `PHP_BINARY` can select another native PHP executable. The browser loads its own upstream PHP extensions; the host PHP executable is used only to compose dependencies.

Installation runs outside the Git checkout with a fixed root package version, disabled scripts and plugins, and an isolated Composer home. The vendor cache key includes the manifest, lock, archive pins, vendor inventory and Composer binary identity. Cached files receive the same complete inventory verification as a fresh installation.

`scripts/jcb-package.mjs` verifies the original JCB archive, replaces the spreadsheet vendor dependencies, applies the reviewed interface declaration, and preserves vendor access-protection files and all dependency licenses. ZIP entries use a fixed timestamp and deterministic ordering. Build output records the original package checksum, dependency and Composer identities, source overlay hashes, and the resulting archive checksum in a sidecar provenance JSON file. The recipe references the derived archive's checksum. The original upstream package remains unchanged.

The same derived package includes the [original sponsor banners](../jcb-banners/README.md) with verified asset pins and a reviewed correction to the wide magazine image reference. Banner sources, installed paths and helper hashes are also included in package provenance.

The [dashboard community artwork](../jcb-dashboard-assets/README.md) is also included as original, checksum-verified snapshots. JCB's contributor and sponsor links stay intact, while image requests remain within the isolated Joomla site.

Inside the derived package, `vendor-source-inventory.json` preserves the clean Composer inventory. The separate `vendor-inventory.json` describes every final vendor file, including the reviewed packing and numeric-range adjustments and retained access-protection files. Provenance records both inventory checksums and each overlay's original and resulting file hashes. The vendor cache always contains the unmodified Composer output and is verified before overlays are applied in memory.

The actual WASM validation in `test/jcb-spreadsheet.integration.mjs` exercises XLS and XLSX writing and reading, Unicode text, text with leading zeros, numeric values, formulas and JCB's chunk reader across all three PHP runtimes. The browser suite also opens the installed JCB administrator route.

## Updating dependencies

Resolve updates for the declared 32-bit platform using the pinned Composer binary in a directory outside the Git checkout. Review the upstream support status and Composer audit output. Download each locked archive, record its SHA-256 in `packages.json` and its archive checksum in the lock, then install from that lock with scripts and plugins disabled. Regenerate `vendor-inventory.json` from the resulting vendor directory. Keep the root version fixed and preserve all upstream licenses.

Run the source checks, the full spreadsheet integration suite and the actual JCB browser scenarios before accepting updated hashes. An upstream package with a different source overlay hash requires an explicit compatibility review.
