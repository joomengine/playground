# Adminer 6.2.0

The unmodified multilingual MySQL/MariaDB release is retained here with its
published SHA-256 digest and exact size in `provenance.json`. JoomEngine distributes
it under its Apache-2.0 option; the upstream file retains both offered licenses.

`scripts/prepare-adminer.mjs` verifies the original bytes and creates a derived
runtime asset. Its exact, fail-closed replacements adapt Adminer's PDO driver
to `pdo_mariadb_wasm`: it selects the existing embedded database, requests emulated
prepares, and omits native mysql-client attributes absent from this bridge. The adapter translates the bridge’s result metadata into Adminer’s existing
MariaDB field representation. Stored routine/event/user-grant administration is
not offered because those system tables are absent from the embedded engine.
The embedded root connection reports empty column privileges; the adapter
reflects its existing select/insert/update access in Adminer’s field UI. The
MariaDB/PHP engine binaries, bridge and database credentials are unchanged.

The wrapper in `src/database/index.php` supplies the active site's embedded
connection through Adminer's documented customization hooks. Its local login is
specific to the owner runtime. Adminer's session and CSRF checks remain in place;
this is not an internet-facing, passwordless Adminer installation. External server
login, permanent login and Adminer's service worker/update check are disabled.

All tool files are installed lazily under `/internal/adminer`, outside the Joomla
workspace and portable exports. A reserved virtual `__adminer/` route temporarily
changes only the CGI prefix/document root for that serialized request. The same
PHP request queue and MariaDB worker serve Joomla and Adminer.

Run `node scripts/prepare-adminer.mjs dist/assets/adminer` to stage the verified
assets. The normal build calls the same function and retains the resulting hashes.
