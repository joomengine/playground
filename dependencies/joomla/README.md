# Joomla configuration adapter

Rocket uses Joomla's own installation, authentication, forms, menu models, template models and configuration save flow. The bundled Joomla releases retain their original GPL-2.0-or-later notices and license.

`src/joomla/managed-database.mjs` adapts the two-line connection check in the administrator Global Configuration model and in the `config:set` console command after verifying each complete original file's SHA-256. The reviewed sources are:

- [Joomla 5.4.10 ApplicationModel.php](https://github.com/joomla/joomla-cms/blob/5.4.10/administrator/components/com_config/src/Model/ApplicationModel.php): `f53ce977b42d0c373660fe4c4cb22313b8ad972809c76afdda266cad01336cee`
- [Joomla 6.2.0 ApplicationModel.php](https://github.com/joomla/joomla-cms/blob/6.2.0/administrator/components/com_config/src/Model/ApplicationModel.php): `4c818d664dccb05f12a19930275cd7b3cc64ad54c7b1a98bfd1e7b6d9314abf3`

- [Joomla 5.4.10 SetConfigurationCommand.php](https://github.com/joomla/joomla-cms/blob/5.4.10/libraries/src/Console/SetConfigurationCommand.php): `7de63a108161b5d57414c1f93a49a8889b7aaa8c9dc6c6f886d4aa4da9ff5e95`
- [Joomla 6.2.0 SetConfigurationCommand.php](https://github.com/joomla/joomla-cms/blob/6.2.0/libraries/src/Console/SetConfigurationCommand.php): `7b57dab5a8c1a3215c4febaa8b91a763e67f0fe3a52970da15f0b160759d17cd`

Joomla normally creates a second PDO connection to validate database settings while saving Global Configuration. The embedded bridge has one active database lease. In the browser, the adapter rejects changes to managed database credentials, connection options and session storage, and validates the live Joomla container connection and its server version. Joomla's remaining form validation, permission checks, request token checks, events and configuration save logic continue normally. It does not pretend that a second independent database connection exists.

The branch is active only when the `pdo_mariadb_wasm` PHP extension is loaded. On a conventional PHP server, exported Joomla files execute the original connection validation code. The original model's license header remains intact. A changed source file or new Joomla release fails the checksum check and must be reviewed explicitly before this adapter is updated.

The native provisioning integration exercises the real Joomla configuration command, verifies that an ordinary site-name change persists, and verifies that changing the managed database name is rejected without changing the running site's configuration.
