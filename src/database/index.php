<?php
/** Adminer entry point for one browser-owned JoomEngine site. */

if (!extension_loaded('pdo_mariadb_wasm')) {
    http_response_code(503);
    exit('The Playground MariaDB driver is unavailable.');
}
if (!is_file('/persist/www/configuration.php')) {
    http_response_code(409);
    exit('Launch a Joomla site before opening its database.');
}
require_once '/persist/www/configuration.php';
$site = new \JConfig();
if (!isset($site->db) || !is_string($site->db) || !preg_match('/^[a-zA-Z0-9_]+$/D', $site->db)) {
    http_response_code(409);
    exit('The active site does not identify a supported embedded database.');
}
define('Adminer\JOOMENGINE_DATABASE', $site->db);
unset($site);

// A local owner session opens only its own embedded connection. User input must
// never turn the viewer into a connection form for remote servers/databases.
if (isset($_POST['auth']) || isset($_POST['password_less'])) {
    http_response_code(400);
    exit('External database login is unavailable in Playground.');
}
$_GET['server'] = '';
$_GET['username'] = 'root';
$_GET['db'] = \Adminer\JOOMENGINE_DATABASE;
unset($_COOKIE['adminer_permanent']);

function adminer_object() {
    // Called after Adminer starts its separate adminer_sid session. All ordinary
    // form submissions still use Adminer's own CSRF token verification.
    $_SESSION['pwds']['server']['']['root'] = '';
    return new class extends \Adminer\Adminer {
        function credentials() { return array('', 'root', ''); }
        function login($username, $password) { return $username === 'root' && $password === ''; }
        function database() { return \Adminer\JOOMENGINE_DATABASE; }
        function databases($flush = true) { return array(\Adminer\JOOMENGINE_DATABASE); }
        function permanentLogin($create = false) { return ''; }
        function verifyVersion() { return false; }
        function serviceWorker() {}
        function headers() {
            header('X-Frame-Options: SAMEORIGIN');
            header('Cache-Control: no-store');
        }
        function csp(array $policies) {
            foreach ($policies as &$policy) {
                $policy['connect-src'] = "'self'";
                $policy['frame-src'] = "'none'";
                $policy['frame-ancestors'] = "'self'";
                $policy['worker-src'] = "'none'";
            }
            return $policies;
        }
        function head($dark = null) {
            echo '<script nonce="' . \Adminer\h(\Adminer\get_nonce()) . '" src="bridge.js"></script>';
            return parent::head($dark);
        }
        function css() { return array('adminer.css' => ''); }
    };
}
require __DIR__ . '/adminer.php';
