<?php
try {
    $root = playgroundRoot($playground);
    if (is_file($root . '/configuration.php')) {
        throw new RuntimeException('A Joomla configuration already exists; reset the site before reinstalling.');
    }
    if (!is_dir($root) && !mkdir($root, 0755, true)) {
        throw new RuntimeException('Cannot create the Joomla document root.');
    }
    $zip = playgroundValidateArchive($playground['archive']);
    foreach (['installation/joomla.php', 'installation/src/Console/InstallCommand.php', 'libraries/vendor/autoload.php', 'index.php'] as $required) {
        if ($zip->locateName($required) === false) {
            throw new RuntimeException('The archive is not a complete Joomla installation package.');
        }
    }
    if (!$zip->extractTo($root)) {
        throw new RuntimeException('Joomla archive extraction failed.');
    }
    $zip->close();
    unlink($playground['archive']);
    playgroundFinish(['ok' => true]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
