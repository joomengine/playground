<?php
try {
    $root = playgroundRoot($playground);
    if (!is_file($root . '/configuration.php')) {
        throw new RuntimeException('Joomla configuration is missing.');
    }
    require $root . '/configuration.php';
    $configuration = new JConfig();
    $connection = new PDO('mysql:dbname=' . $configuration->db . ';charset=utf8mb4', $configuration->user, $configuration->password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $prefix = $configuration->dbprefix;
    if (!preg_match('/^[a-zA-Z0-9_]+$/', $prefix)) {
        throw new RuntimeException('The Joomla table prefix is invalid.');
    }
    $users = $connection->query('SELECT COUNT(*) FROM `' . $prefix . 'users`')->fetchColumn();
    if ((int) $users < 1) {
        throw new RuntimeException('The saved MariaDB database does not contain a Joomla administrator.');
    }
    $languageSettings = $connection->query('SELECT params FROM `' . $prefix . 'extensions` WHERE type = \'component\' AND element = \'com_languages\'')->fetchColumn();
    $languageSettings = json_decode($languageSettings ?: '{}', true, 512, JSON_THROW_ON_ERROR);
    $connection = null;
    $manifest = simplexml_load_file($root . '/administrator/manifests/files/joomla.xml');
    if (!$manifest) {
        throw new RuntimeException('Joomla version manifest is missing.');
    }
    playgroundFinish(['ok' => true, 'version' => (string) $manifest->version, 'siteName' => $configuration->sitename, 'language' => $languageSettings['site'] ?? 'en-GB']);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
