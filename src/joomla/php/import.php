<?php
/** Validate payload bytes before touching the destination site or database. */
function playgroundValidateContentHash(ZipArchive $zip, array $metadata): bool
{
    if (!is_array($metadata['playground'] ?? null) || !array_key_exists('contentHash', $metadata['playground'])) {
        return false;
    }
    $expected = $metadata['playground']['contentHash'];
    if (!is_array($expected) || ($expected['algorithm'] ?? null) !== 'sha256'
        || ($expected['format'] ?? null) !== 'joomengine-site-payload-v1'
        || !is_string($expected['value'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D', $expected['value'])) {
        throw new RuntimeException('Package validation failed: the content hash is invalid or unsupported.');
    }
    $records = [];
    for ($index = 0; $index < $zip->numFiles; ++$index) {
        $entry = $zip->statIndex($index);
        $name = $entry['name'];
        if (str_ends_with($name, '/') || (!str_starts_with($name, 'site/') && !in_array($name, ['database.sql', 'database.ndjson'], true))) {
            continue;
        }
        if (isset($records[$name])) {
            throw new RuntimeException('Package validation failed: the payload contains duplicate files.');
        }
        $stream = $zip->getStream($name);
        if ($stream === false) {
            throw new RuntimeException('Package validation failed: a payload file cannot be read.');
        }
        $context = hash_init('sha256');
        try {
            $bytes = hash_update_stream($context, $stream);
        } finally {
            fclose($stream);
        }
        if ($bytes !== $entry['size']) {
            throw new RuntimeException('Package validation failed: a payload file is incomplete.');
        }
        $records[$name] = ['size' => $bytes, 'sha256' => hash_final($context)];
    }
    // PHP string ordering compares UTF-8 bytes, matching the exporter framing.
    uksort($records, 'strcmp');
    $context = hash_init('sha256');
    foreach ($records as $name => $entry) {
        hash_update($context, strlen($name) . ':' . $name . ':' . $entry['size'] . ':' . $entry['sha256'] . "\n");
    }
    if (!hash_equals($expected['value'], hash_final($context))) {
        throw new RuntimeException('Package validation failed: the site files or database do not match the content hash.');
    }
    return true;
}

try {
    $root = playgroundRoot($playground);
    if (is_file($root . '/configuration.php') || (is_dir($root) && count(scandir($root)) > 2)) {
        throw new RuntimeException('The destination must be empty before importing a prebuilt site.');
    }
    $zip = playgroundValidateArchive($playground['archive'], 100000);
    foreach (['export.json', 'database.ndjson', 'site/configuration.php', 'site/index.php', 'site/libraries/vendor/autoload.php', 'site/administrator/manifests/files/joomla.xml'] as $required) {
        if ($zip->locateName($required) === false) {
            throw new RuntimeException('The prebuilt site is missing ' . $required . '.');
        }
    }
    if ($zip->locateName('site/installation/joomla.php') !== false) {
        throw new RuntimeException('A prebuilt site must already have completed Joomla installation.');
    }
    $metadata = json_decode($zip->getFromName('export.json'), true, 512, JSON_THROW_ON_ERROR);
    if (($metadata['format'] ?? null) !== 'joomengine-playground-export' || ($metadata['schemaVersion'] ?? null) !== 1) {
        throw new RuntimeException('The prebuilt site uses an unsupported export format.');
    }
    $contentHashValidated = playgroundValidateContentHash($zip, $metadata);
    $manifest = simplexml_load_string($zip->getFromName('site/administrator/manifests/files/joomla.xml'), SimpleXMLElement::class, LIBXML_NONET);
    if (!$manifest || (string) $manifest->version !== $playground['joomlaVersion'] || ($metadata['joomlaVersion'] ?? null) !== $playground['joomlaVersion']) {
        throw new RuntimeException('The prebuilt site does not match the selected Joomla version.');
    }
    $connection = new PDO('mysql:dbname=' . $playground['database'] . ';charset=utf8mb4', 'root', '', [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    if ($connection->query('SHOW TABLES')->fetchColumn() !== false) {
        throw new RuntimeException('The destination database must be empty before importing a prebuilt site.');
    }
    if (!is_dir($root) && !mkdir($root, 0755, true)) {
        throw new RuntimeException('Cannot create the imported site directory.');
    }
    $seen = [];
    for ($index = 0; $index < $zip->numFiles; $index++) {
        $name = $zip->getNameIndex($index);
        if (!str_starts_with($name, 'site/') || $name === 'site/') {
            continue;
        }
        $relative = substr($name, 5);
        $normalized = rtrim($relative, '/');
        if ($normalized === '' || in_array('.', explode('/', $normalized), true) || in_array('', explode('/', $normalized), true) || isset($seen[$normalized])) {
            throw new RuntimeException('The prebuilt site contains duplicate or ambiguous file paths.');
        }
        $seen[$normalized] = true;
        $target = $root . '/' . $relative;
        if (str_ends_with($relative, '/')) {
            if (!is_dir($target) && !mkdir($target, 0755, true)) {
                throw new RuntimeException('Cannot create an imported site directory.');
            }
            continue;
        }
        if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0755, true)) {
            throw new RuntimeException('Cannot create an imported file directory.');
        }
        $source = $zip->getStream($name);
        $destination = fopen($target, 'wb');
        if ($source === false || $destination === false) {
            throw new RuntimeException('Cannot extract an imported site file.');
        }
        $copied = stream_copy_to_stream($source, $destination);
        fclose($source);
        fclose($destination);
        if ($copied !== $zip->statIndex($index)['size']) {
            throw new RuntimeException('An imported file was not extracted completely.');
        }
    }
    $statements = $zip->getStream('database.ndjson');
    if ($statements === false) {
        throw new RuntimeException('Cannot open the database statement stream.');
    }
    // Consecutive inserts share a transaction until the next DDL boundary.
    // MariaDB commits DDL implicitly; the final group is committed below.
    $connection->exec('SET autocommit=0');
    $count = 0;
    // JSON can escape each source byte as six ASCII bytes. Data values in new
    // exports are chunked; this also bounds older or externally supplied dumps.
    $maximumStatementBytes = 4 * 1024 * 1024;
    while (($line = fgets($statements, $maximumStatementBytes * 6 + 4)) !== false) {
        if (!str_ends_with($line, "\n") && !feof($statements)) {
            throw new RuntimeException('A database statement exceeds the import size limit.');
        }
        if (trim($line) === '') {
            continue;
        }
        $statement = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
        if (!is_string($statement) || trim($statement) === '' || str_contains($statement, "\0")) {
            throw new RuntimeException('The prebuilt database contains an invalid SQL statement.');
        }
        if (strlen($statement) > $maximumStatementBytes) {
            throw new RuntimeException('A database statement exceeds 4 MiB. Export large values as bounded SQL chunks before importing.');
        }
        try {
            $connection->exec($statement);
        } catch (Throwable $error) {
            throw new RuntimeException('Cannot restore database statement ' . ($count + 1) . ': ' . $error->getMessage(), 0, $error);
        }
        $count++;
    }
    $connection->exec('COMMIT');
    fclose($statements);
    $zip->close();
    unlink($playground['archive']);
    if ($count === 0) {
        throw new RuntimeException('The prebuilt database has no statements.');
    }
    $connection = null;
    require $root . '/configuration.php';
    require_once $root . '/libraries/vendor/autoload.php';
    $configuration = new \Joomla\Registry\Registry(new JConfig());
    if (!preg_match('/^[a-zA-Z0-9_]+$/', $configuration->get('dbprefix', ''))) {
        throw new RuntimeException('The imported site has an invalid table prefix.');
    }
    $sessions = dirname($root) . '/sessions';
    foreach ([$sessions, $root . '/tmp', $root . '/administrator/logs'] as $directory) {
        if (!is_dir($directory) && !mkdir($directory, $directory === $sessions ? 0700 : 0755, true)) {
            throw new RuntimeException('Cannot create imported site runtime directories.');
        }
    }
    foreach ([
        'dbtype' => 'mysql', 'host' => 'localhost', 'user' => 'root', 'password' => '',
        'db' => $playground['database'], 'dbencryption' => 0, 'dbsslverifyservercert' => false,
        'dbsslkey' => '', 'dbsslcert' => '', 'dbsslca' => '', 'dbsslcipher' => '',
        'sitename' => $playground['siteName'], 'live_site' => '', 'force_ssl' => 0,
        'cookie_domain' => '', 'cookie_path' => '/', 'secret' => bin2hex(random_bytes(32)),
        'tmp_path' => $root . '/tmp', 'log_path' => $root . '/administrator/logs',
        'session_handler' => 'filesystem', 'session_filesystem_path' => $sessions,
    ] as $key => $value) {
        $configuration->set($key, $value);
    }
    $data = $configuration->toString('PHP', ['class' => 'JConfig', 'closingtag' => false]);
    if (file_put_contents($root . '/configuration.php', $data) !== strlen($data)) {
        throw new RuntimeException('Cannot configure the imported browser site.');
    }
    playgroundFinish(['ok' => true, 'version' => $playground['joomlaVersion'], 'statements' => $count, 'contentHashValidated' => $contentHashValidated]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
