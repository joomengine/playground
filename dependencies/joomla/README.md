# Joomla configuration adapter

Rocket uses Joomla's own installation, authentication, forms, menu models, template models and configuration save flow. The bundled Joomla releases retain their original GPL-2.0-or-later notices and license.

`src/joomla/managed-database.mjs` adapts two lines in the administrator Global Configuration model after verifying the complete original file's SHA-256. The reviewed sources are:

- [Joomla 5.4.10 ApplicationModel.php](https://github.com/joomla/joomla-cms/blob/5.4.10/administrator/components/com_config/src/Model/ApplicationModel.php): `f53ce977b42d0c373660fe4c4cb22313b8ad972809c76afdda266cad01336cee`
- [Joomla 6.2.0 ApplicationModel.php](https://github.com/joomla/joomla-cms/blob/6.2.0/administrator/components/com_config/src/Model/ApplicationModel.php): `4c818d664dccb05f12a19930275cd7b3cc64ad54c7b1a98bfd1e7b6d9314abf3`

Joomla normally creates a second PDO connection to validate database settings while saving Global Configuration. The embedded bridge has one active database lease. In the browser, the adapter rejects changes to managed database credentials, connection options and session storage, and validates the live Joomla container connection and its server version. Joomla's remaining form validation, permission checks, request token checks, events and configuration save logic continue normally. It does not pretend that a second independent database connection exists.

The branch is active only when the `pdo_mariadb_wasm` PHP extension is loaded. On a conventional PHP server, exported Joomla files execute the original connection validation code. The original model's license header remains intact. A changed source file or new Joomla release fails the checksum check and must be reviewed explicitly before this adapter is updated.

The native provisioning integration exercises the real Joomla configuration command, verifies that an ordinary site-name change persists, and verifies that changing the managed database name is rejected without changing the running site's configuration.
