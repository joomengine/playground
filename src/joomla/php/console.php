<?php
try {
    $root = playgroundRoot($playground);
    if (!is_file($root . '/configuration.php')) {
        throw new RuntimeException('Install Joomla before running a command.');
    }
    if (isset($playground['archive'])) {
        $zip = playgroundValidateArchive($playground['archive']);
        $zip->close();
    }
    chdir($root);
    playgroundRuntimeConstants($root);
    define('_JEXEC', 1);
    define('JPATH_BASE', $root);
    require $root . '/includes/defines.php';
    require $root . '/includes/framework.php';
    $argv = array_merge(['cli/joomla.php'], $playground['argv'], ['--no-interaction', '--no-ansi']);
    playgroundConsoleStreams($argv);
    $input = new \Symfony\Component\Console\Input\ArgvInput($argv);
    $input->setInteractive(false);
    $output = new \Symfony\Component\Console\Output\BufferedOutput();
    $container = \Joomla\CMS\Factory::getContainer();
    playgroundConsoleSession($container);
    $config = $container->get('config');
    $language = $container->get(\Joomla\CMS\Language\LanguageFactoryInterface::class)->createLanguage(
        $config->get('language'), $config->get('debug_lang')
    );
    $language->load('lib_joomla', JPATH_ADMINISTRATOR, 'en-GB', true);
    $language->load('joomla', JPATH_ADMINISTRATOR, 'en-GB', true);
    $application = new \Joomla\CMS\Application\ConsoleApplication(
        $config, $container->get(\Joomla\Event\DispatcherInterface::class), $container, $language, $input, $output
    );
    $application->setCommandLoader($container->get(\Joomla\Console\Loader\LoaderInterface::class));
    $application->setLogger($container->get(\Psr\Log\LoggerInterface::class));
    $application->setSession($container->get(\Joomla\Session\SessionInterface::class));
    if (method_exists($application, 'setUserFactory')) {
        $application->setUserFactory($container->get(\Joomla\CMS\User\UserFactoryInterface::class));
    }
    if (method_exists($application, 'setDatabase')) {
        $application->setDatabase($container->get(\Joomla\Database\DatabaseInterface::class));
    }
    $exitCode = playgroundRunConsole($application);
    if (isset($playground['archive']) && is_file($playground['archive'])) {
        unlink($playground['archive']);
    }
    playgroundFinish(['ok' => $exitCode === 0, 'exitCode' => $exitCode, 'output' => $output->fetch()]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage(), 'output' => isset($output) ? $output->fetch() : '']);
}
