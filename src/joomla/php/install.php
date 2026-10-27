<?php
try {
    $root = playgroundRoot($playground);
    if (is_file($root . '/configuration.php')) {
        throw new RuntimeException('Joomla is already configured.');
    }
    foreach (['pdo', 'pdo_mariadb_wasm', 'session', 'zlib', 'xml', 'dom', 'simplexml', 'mbstring', 'iconv'] as $extension) {
        if (!extension_loaded($extension)) {
            throw new RuntimeException('Missing required PHP extension: ' . $extension);
        }
    }
    if (!in_array('mysql', PDO::getAvailableDrivers(), true)) {
        throw new RuntimeException('The MariaDB PDO driver is unavailable.');
    }
    chdir($root);
    define('_JEXEC', 1);
    define('JPATH_BASE', $root . '/installation');
    require JPATH_BASE . '/includes/defines.php';
    require JPATH_BASE . '/includes/framework.php';
    JLoader::registerNamespace('Joomla\\CMS\\Installation', JPATH_INSTALLATION . '/src', false, false);

    $argv = [
        'installation/joomla.php', 'install', '--no-interaction', '--no-ansi',
        '--site-name=' . $playground['siteName'],
        '--admin-user=' . $playground['admin']['name'],
        '--admin-username=' . $playground['admin']['username'],
        '--admin-password=' . $playground['admin']['password'],
        '--admin-email=' . $playground['admin']['email'],
        '--db-type=mysql', '--db-host=localhost', '--db-user=root', '--db-pass=',
        '--db-name=' . $playground['database'], '--db-prefix=jml_', '--db-encryption=0',
    ];
    playgroundConsoleStreams($argv);
    $input = new \Symfony\Component\Console\Input\ArgvInput($argv);
    $input->setInteractive(false);
    $output = new \Symfony\Component\Console\Output\BufferedOutput();
    $container = \Joomla\CMS\Factory::getContainer();
    $container->registerServiceProvider(new \Joomla\CMS\Installation\Service\Provider\Application());
    playgroundConsoleSession($container);
    $language = $container->get(\Joomla\CMS\Language\LanguageFactoryInterface::class)->createLanguage('en-GB', false);
    $application = new \Joomla\CMS\Installation\Application\CliInstallationApplication(
        $input, $output, $container->get('config'), $language
    );
    $application->setDispatcher($container->get(\Joomla\Event\DispatcherInterface::class));
    $application->setLogger($container->get(\Psr\Log\LoggerInterface::class));
    $application->setSession($container->get(\Joomla\Session\SessionInterface::class));
    $exitCode = playgroundRunConsole($application);
    if ($exitCode !== 0 || !is_file($root . '/configuration.php') || is_dir($root . '/installation')) {
        throw new RuntimeException('Joomla installation failed with exit status ' . $exitCode . '. ' . $output->fetch());
    }
    // Keep browser sessions alongside the site's persisted files. The database
    // session handler closes/reopens PDO during session ID rotation; outstanding
    // statements can retain its previous lease on the single embedded connection.
    require_once $root . '/configuration.php';
    $settings = new \Joomla\Registry\Registry(new JConfig());
    $sessions = dirname($root) . '/sessions';
    if (!is_dir($sessions) && !mkdir($sessions, 0700, true)) {
        throw new RuntimeException('Cannot create the persistent Joomla session directory.');
    }
    $settings->set('session_handler', 'filesystem');
    $settings->set('session_filesystem_path', $sessions);
    $settings->set('cookie_path', '/');
    $configuration = $settings->toString('PHP', ['class' => 'JConfig', 'closingtag' => false]);
    if (file_put_contents($root . '/configuration.php', $configuration) !== strlen($configuration)) {
        throw new RuntimeException('Cannot save the browser session configuration.');
    }
    playgroundFinish(['ok' => true, 'version' => JVERSION, 'output' => $output->fetch()]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage(), 'output' => isset($output) ? $output->fetch() : '']);
}
