<?php
// Exercise the same typed primary-key branch used by the guided-tour AJAX model.
define('_JEXEC', 1);
define('JPATH_BASE', '/persist/www');
require JPATH_BASE . '/includes/defines.php';
require JPATH_BASE . '/includes/framework.php';
foreach (['STDIN' => 'php://stdin', 'STDOUT' => 'php://stdout', 'STDERR' => 'php://stderr'] as $name => $stream) {
    if (!defined($name)) {
        define($name, fopen($stream, $name === 'STDIN' ? 'r' : 'w'));
    }
}
$_SERVER['argv'] = ['cli/joomla.php'];
$_SERVER['argc'] = 1;

$container = \Joomla\CMS\Factory::getContainer();
$container->alias('session', 'session.cli')
    ->alias('JSession', 'session.cli')
    ->alias(\Joomla\CMS\Session\Session::class, 'session.cli')
    ->alias(\Joomla\Session\Session::class, 'session.cli')
    ->alias(\Joomla\Session\SessionInterface::class, 'session.cli');
$language = $container->get(\Joomla\CMS\Language\LanguageFactoryInterface::class)->createLanguage('en-GB', false);
$application = new \Joomla\CMS\Application\ConsoleApplication(
    $container->get('config'),
    $container->get(\Joomla\Event\DispatcherInterface::class),
    $container,
    $language,
    new \Symfony\Component\Console\Input\ArrayInput([]),
    new \Symfony\Component\Console\Output\BufferedOutput()
);
$application->setSession($container->get(\Joomla\Session\SessionInterface::class));
$application->setUserFactory($container->get(\Joomla\CMS\User\UserFactoryInterface::class));
\Joomla\CMS\Factory::$application = $application;
$application->createExtensionNamespaceMap();
$database = $container->get(\Joomla\Database\DatabaseInterface::class);
$row = $database->setQuery('SELECT id, uid FROM #__guidedtours WHERE published = 1 AND autostart = 1 ORDER BY id LIMIT 1')->loadObject();
if (!$row) {
    throw new RuntimeException('The installed Joomla site has no published autostart tour.');
}
$model = $application->bootComponent('com_guidedtours')->getMVCFactory()->createModel('Tour', 'Administrator', ['ignore_request' => true]);
$tour = $model->getItem($row->id);
if (!is_int($row->id) || !$tour || $tour->uid !== $row->uid) {
    throw new RuntimeException('The guided-tour model did not resolve the native integer primary key to its UID.');
}
header('Content-Type: application/json');
echo json_encode([
    'id' => $row->id,
    'idType' => get_debug_type($row->id),
    'expectedUid' => $row->uid,
    'uid' => $tour->uid,
], JSON_THROW_ON_ERROR);
