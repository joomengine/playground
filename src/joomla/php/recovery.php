<?php
try {
    $root = playgroundRoot($playground);
    $path = $root . '/configuration.php';
    if (!is_file($path)) {
        throw new RuntimeException('This installation has no configuration file. Export its files before resetting it.');
    }
    $original = file_get_contents($path);
    if ($original === false) throw new RuntimeException('Cannot read the saved Joomla configuration.');
    $updated = $original;
    foreach (['debug' => 'false', 'error_reporting' => "'default'"] as $name => $value) {
        $pattern = '/(\bpublic\s+\$' . $name . '\s*=\s*)(?:true|false|-?\d+|\'[^\'\\\\]*\'|"[^"\\\\]*")(\s*;)/';
        $updated = preg_replace_callback($pattern, static fn(array $match): string => $match[1] . $value . $match[2], $updated, -1, $count);
        if ($updated === null || $count !== 1) {
            throw new RuntimeException('The configuration cannot be repaired automatically. Export the site to inspect configuration.php.');
        }
    }
    // Parse without executing configuration.php, including any extension-supplied code.
    token_get_all($updated, TOKEN_PARSE);
    $directory = dirname($root) . '/meta';
    if (!is_dir($directory) && !mkdir($directory, 0700, true)) throw new RuntimeException('Cannot create recovery storage.');
    $backup = $directory . '/configuration-' . hash('sha256', $original) . '.php';
    if (file_put_contents($backup, $original) !== strlen($original)) throw new RuntimeException('Cannot back up the original configuration.');
    chmod($backup, 0600);
    $temporary = $path . '.recovery';
    if (file_put_contents($temporary, $updated) !== strlen($updated)) throw new RuntimeException('Cannot write repaired configuration.');
    chmod($temporary, fileperms($path) & 0777);
    if (!rename($temporary, $path)) throw new RuntimeException('Cannot replace the saved configuration.');
    playgroundFinish(['ok' => true, 'backup' => $backup, 'debug' => false, 'errorReporting' => 'default']);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
