<?php
/** Browser-side Joomla provisioning helpers. */

$playgroundFinished = false;
ob_start();

function playgroundFinish(array $result): void
{
    global $playgroundFinished;
    $playgroundFinished = true;
    $output = ob_get_clean();
    if (!isset($result['output'])) {
        $result['output'] = $output;
    } elseif ($output !== '') {
        $result['output'] .= $output;
    }
    header('Content-Type: application/json; charset=utf-8');
    echo "\n__JOOMENGINE_RESULT__" . json_encode($result, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
}

register_shutdown_function(static function (): void {
    global $playgroundFinished;
    if (!$playgroundFinished) {
        $error = error_get_last();
        playgroundFinish([
            'ok' => false,
            'error' => $error['message'] ?? 'PHP terminated before provisioning completed.',
        ]);
    }
});

function playgroundRoot(array $options): string
{
    $root = rtrim($options['root'] ?? '/persist/www', '/');
    if ($root === '' || $root[0] !== '/' || str_contains($root, "\0") || str_contains($root, '/..')) {
        throw new InvalidArgumentException('Invalid Joomla document root.');
    }
    return $root;
}

function playgroundValidateArchive(string $path): ZipArchive
{
    if (!class_exists(ZipArchive::class)) {
        throw new RuntimeException('The PHP zip extension is required to install Joomla packages.');
    }
    $zip = new ZipArchive();
    $opened = $zip->open($path, ZipArchive::CHECKCONS);
    if ($opened !== true) {
        throw new RuntimeException('Cannot open ZIP package (error ' . $opened . ').');
    }
    $expandedSize = 0;
    for ($index = 0; $index < $zip->numFiles; ++$index) {
        $entry = $zip->statIndex($index);
        $name = $entry['name'];
        if ($name === '' || str_contains($name, "\0") || str_contains($name, '\\')
            || $name[0] === '/' || preg_match('/^[a-z]:/i', $name)
            || in_array('..', explode('/', $name), true)) {
            throw new RuntimeException('ZIP contains an unsafe entry path.');
        }
        $zip->getExternalAttributesIndex($index, $operatingSystem, $attributes);
        if ($operatingSystem === ZipArchive::OPSYS_UNIX && (($attributes >> 16) & 0170000) === 0120000) {
            throw new RuntimeException('ZIP symbolic links are not supported.');
        }
        $expandedSize += $entry['size'];
        if ($expandedSize > 768 * 1024 * 1024 || $zip->numFiles > 50000) {
            throw new RuntimeException('ZIP package exceeds the extraction limits.');
        }
    }
    return $zip;
}

function playgroundConsoleStreams(array $argv): void
{
    foreach (['STDIN' => 'php://stdin', 'STDOUT' => 'php://stdout', 'STDERR' => 'php://stderr'] as $name => $stream) {
        if (!defined($name)) {
            define($name, fopen($stream, $name === 'STDIN' ? 'r' : 'w'));
        }
    }
    $_SERVER['argv'] = $argv;
    $_SERVER['argc'] = count($argv);
    $GLOBALS['argv'] = $argv;
    $GLOBALS['argc'] = count($argv);
    putenv('COLUMNS=100');
    putenv('LINES=30');
}

function playgroundConsoleSession($container): void
{
    $container->alias('session', 'session.cli')
        ->alias('JSession', 'session.cli')
        ->alias(\Joomla\CMS\Session\Session::class, 'session.cli')
        ->alias(\Joomla\Session\Session::class, 'session.cli')
        ->alias(\Joomla\Session\SessionInterface::class, 'session.cli');
}

function playgroundRunConsole($application): int
{
    $exitCode = null;
    $application->setAutoExit(false);
    $application->setCatchThrowables(false);
    $application->getDispatcher()->addListener(
        \Joomla\Console\ConsoleEvents::TERMINATE,
        static function ($event) use (&$exitCode): void {
            $exitCode = $event->getExitCode();
        }
    );
    \Joomla\CMS\Factory::$application = $application;
    $application->execute();
    if ($exitCode === null) {
        throw new RuntimeException('Joomla command did not report an exit status.');
    }
    return $exitCode;
}
