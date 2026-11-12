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
            'code' => 'PHP_TERMINATED',
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

/** Change only this CGI request, before Joomla or package installer hooks run. */
function playgroundInstallationAllowance(array $options): void
{
    if (!array_key_exists('installationExecutionTimeSeconds', $options)) {
        return;
    }
    $seconds = $options['installationExecutionTimeSeconds'];
    if (!is_int($seconds) || $seconds < 5 || $seconds > 300) {
        throw new InvalidArgumentException('Installation execution time must be between 5 and 300 seconds.');
    }
    if (!set_time_limit($seconds) || (int) ini_get('max_execution_time') !== $seconds) {
        throw new RuntimeException('PHP could not apply the installation execution allowance.');
    }
}

function playgroundValidateArchive(string $path, int $maximumEntries = 50000): ZipArchive
{
    if ($maximumEntries < 1 || $maximumEntries > 100000) throw new InvalidArgumentException('Invalid ZIP entry limit.');
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
        if ($expandedSize > 768 * 1024 * 1024 || $zip->numFiles > $maximumEntries) {
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

function playgroundRuntimeConstants(string $root): void
{
    $entrypoint = file_get_contents($root . '/cli/joomla.php');
    if (!preg_match('/const\s+JOOMLA_MINIMUM_PHP\s*=\s*[\'\"]([0-9.]+)[\'\"]/', $entrypoint, $match)) {
        throw new RuntimeException('Cannot determine the Joomla release PHP requirement.');
    }
    define('JOOMLA_MINIMUM_PHP', $match[1]);
    if (version_compare(PHP_VERSION, JOOMLA_MINIMUM_PHP, '<')) {
        throw new RuntimeException('This Joomla release requires PHP ' . JOOMLA_MINIMUM_PHP . ' or newer.');
    }
}

/** Bootstrap Joomla provisioning APIs with a private console session. */
function playgroundApplication(string $root, bool $administratorModels = false): array
{
    chdir($root);
    playgroundRuntimeConstants($root);
    define('_JEXEC', 1);
    define('JPATH_BASE', $root);
    require $root . '/includes/defines.php';
    require $root . '/includes/framework.php';
    playgroundConsoleStreams(['cli/joomla.php']);
    $container = \Joomla\CMS\Factory::getContainer();
    playgroundConsoleSession($container);
    $application = $administratorModels
        ? $container->get(\Joomla\CMS\Application\AdministratorApplication::class)
        : new \Joomla\CMS\Application\ConsoleApplication(
        $container->get('config'),
        $container->get(\Joomla\Event\DispatcherInterface::class),
        $container,
        $container->get(\Joomla\CMS\Language\LanguageFactoryInterface::class)->createLanguage('en-GB', false),
        new \Symfony\Component\Console\Input\ArrayInput([]),
        new \Symfony\Component\Console\Output\BufferedOutput()
    );
    $application->setSession($container->get(\Joomla\Session\SessionInterface::class));
    $application->setUserFactory($container->get(\Joomla\CMS\User\UserFactoryInterface::class));
    $application->setLogger($container->get(\Psr\Log\LoggerInterface::class));
    \Joomla\CMS\Factory::$application = $application;
    if ($administratorModels) {
        $application->loadLanguage($container->get(\Joomla\CMS\Language\LanguageFactoryInterface::class)->createLanguage('en-GB', false));
    }
    $application->createExtensionNamespaceMap();
    return [$application, $container, $container->get(\Joomla\Database\DatabaseInterface::class)];
}

function playgroundStoreTable($table, array $values): void
{
    if (!$table->bind($values) || !$table->check() || !$table->store()) {
        throw new RuntimeException('Cannot save Joomla ' . get_class($table) . ': ' . $table->getError());
    }
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

/** Authenticate the saved site's actual administrator before accessing extension data. */
function playgroundDataAdministrator(string $root, array $options, $application, $container, $database)
{
    $path = dirname($root) . '/meta/administrator.json';
    $credentials = $options['admin'] ?? null;
    if (is_file($path)) {
        $saved = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        if (($saved['schemaVersion'] ?? null) !== 1) throw new RuntimeException('Unsupported saved administrator metadata.');
        $credentials = $saved['administrator'] ?? null;
    }
    if (!is_array($credentials) || !is_string($credentials['username'] ?? null) || !is_string($credentials['password'] ?? null)) {
        throw new RuntimeException('Saved administrator credentials are required to configure extension data.');
    }
    $id = (int) $database->setQuery('SELECT id FROM #__users WHERE block = 0 AND username = ' . $database->quote($credentials['username']))->loadResult();
    $user = $id ? $container->get(\Joomla\CMS\User\UserFactoryInterface::class)->loadUserById($id) : null;
    if (!$user || !$user->authorise('core.admin') || !\Joomla\CMS\User\UserHelper::verifyPassword($credentials['password'], $user->password)) {
        throw new RuntimeException('The saved administrator could not be authenticated as an active Super User.');
    }
    $application->loadIdentity($user);
    $container->get(\Joomla\Session\SessionInterface::class)->set('user', $user);
    return $user;
}

function playgroundDataIdentifier($value, string $label, string $pattern = '/^[a-z][a-z0-9_]*$/'): string
{
    if (!is_string($value) || !preg_match($pattern, $value)) throw new InvalidArgumentException('Invalid ' . $label . '.');
    return $value;
}

/** Resolve a list view using metadata or the installed controller's explicit edit-model mapping. */
function playgroundDataCanonicalTarget(array $target, $application): array
{
    if (($target['kind'] ?? 'record') !== 'record') return $target;
    $component = playgroundDataIdentifier($target['component'] ?? null, 'component', '/^com_[a-z0-9_]+$/');
    $view = playgroundDataIdentifier($target['view'] ?? null, 'administrator view');
    $application->bootComponent($component);
    if ($component === 'com_componentbuilder' && class_exists(\VDM\Joomla\Componentbuilder\Table::class)) {
        $table = new \VDM\Joomla\Componentbuilder\Table();
        if (!$table->exist($view)) {
            foreach ($table->tables() as $entity) foreach ($table->fields($entity, false, true) ?? [] as $field) {
                if (($field['list'] ?? '') === $view) { $target['view'] = $entity; return $target; }
            }
        }
    }
    $path = JPATH_ADMINISTRATOR . '/components/' . $component;
    if (is_file($path . '/forms/' . $view . '.xml')) return $target;
    $controller = $path . '/src/Controller/' . ucfirst($view) . 'Controller.php';
    if (is_file($controller) && preg_match('/function\s+getModel\s*\(\s*\$name\s*=\s*[\x27\x22]([A-Za-z][A-Za-z0-9_]*)[\x27\x22]/', file_get_contents($controller), $match)) {
        $candidate = strtolower($match[1]);
        if (is_file($path . '/forms/' . $candidate . '.xml')) $target['view'] = $candidate;
    }
    if ($target['view'] === $view) foreach (glob($path . '/src/Controller/*Controller.php') ?: [] as $controller) {
        if (!preg_match('/\$view_list\s*=\s*[\x27\x22]' . preg_quote($view, '/') . '[\x27\x22]/', file_get_contents($controller))) continue;
        $candidate = strtolower(substr(basename($controller), 0, -strlen('Controller.php')));
        if (is_file($path . '/forms/' . $candidate . '.xml')) { $target['view'] = $candidate; break; }
    }
    return $target;
}

/** Boot the installed extension's own model, field types, validation rules and language. */
function playgroundDataModel($application, $database, $user, string $component, string $view)
{
    playgroundDataIdentifier($component, 'component', '/^com_[a-z0-9_]+$/');
    playgroundDataIdentifier($view, 'administrator view');
    $installed = (int) $database->setQuery("SELECT extension_id FROM #__extensions WHERE type = 'component' AND enabled = 1 AND element = " . $database->quote($component))->loadResult();
    if (!$installed) throw new RuntimeException('Component ' . $component . ' is not installed and enabled.');
    if (!$user->authorise('core.manage', $component)) throw new RuntimeException('The administrator cannot configure ' . $component . '.');
    $path = JPATH_ADMINISTRATOR . '/components/' . $component;
    $application->getInput()->set('option', $component);
    $application->getInput()->set('view', $view);
    $application->getInput()->set('task', '');
    $application->getInput()->set('id', 0);
    $application->getInput()->set('a_id', 0);
    $application->getLanguage()->load($component, JPATH_ADMINISTRATOR);
    $application->getLanguage()->load($component, $path);
    \Joomla\CMS\Form\Form::addFormPath($path . '/forms');
    \Joomla\CMS\Form\Form::addFieldPath($path . '/models/fields');
    \Joomla\CMS\Form\Form::addRulePath($path . '/models/rules');
    $extension = $application->bootComponent($component);
    if (!method_exists($extension, 'getMVCFactory')) throw new RuntimeException('The component has no administrator model factory.');
    $model = $extension->getMVCFactory()->createModel(ucfirst($view), 'Administrator', ['ignore_request' => true]);
    if (!$model || !method_exists($model, 'getForm') || !method_exists($model, 'save')) {
        throw new RuntimeException('Administrator view ' . $component . '/' . $view . ' has no supported editable model.');
    }
    if (method_exists($model, 'setCurrentUser')) $model->setCurrentUser($user);
    return $model;
}

/** Identity fields are resolved locally; they must never be copied from another site's row. */
function playgroundDataPortableFields(array $data): array
{
    foreach (['id', 'extension_id', 'asset_id', 'guid', 'checked_out', 'checked_out_time', 'created', 'created_by', 'created_user_id', 'modified', 'modified_by', 'modified_user_id', 'version', 'hits', 'rules', 'not_required', 'tags', 'typeAlias'] as $name) unset($data[$name]);
    foreach (array_keys($data) as $name) if (!is_string($name) || str_starts_with($name, '_')) unset($data[$name]);
    return $data;
}

function playgroundDataMerge(array $existing, array $fields): array
{
    foreach ($fields as $key => $value) {
        // Preserve unspecified object properties (especially extension parameters), replace lists.
        if (is_array($value) && !array_is_list($value) && isset($existing[$key]) && is_array($existing[$key]) && !array_is_list($existing[$key])) {
            $existing[$key] = playgroundDataMerge($existing[$key], $value);
        } else {
            $existing[$key] = $value;
        }
    }
    return $existing;
}

function playgroundDataBindings(string $root): array
{
    $path = dirname($root) . '/meta/overlay-bindings.json';
    if (!is_file($path)) return [];
    $document = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    if (($document['schemaVersion'] ?? null) !== 1 || !is_array($document['bindings'] ?? null)) throw new RuntimeException('Invalid deployment record bindings.');
    return $document['bindings'];
}

function playgroundDataSaveBindings(string $root, array $bindings): void
{
    $directory = dirname($root) . '/meta';
    if (!is_dir($directory) && !mkdir($directory, 0700, true)) throw new RuntimeException('Cannot create deployment record metadata.');
    $path = $directory . '/overlay-bindings.json';
    $data = json_encode(['schemaVersion' => 1, 'bindings' => $bindings], JSON_THROW_ON_ERROR);
    if (file_put_contents($path . '.tmp', $data, LOCK_EX) !== strlen($data) || !rename($path . '.tmp', $path)) throw new RuntimeException('Cannot save deployment record bindings.');
    chmod($path, 0600);
}

function playgroundDataTarget(array $entry): string
{
    $target = [];
    foreach (['kind', 'component', 'view', 'element', 'folder', 'clientId'] as $name) if (isset($entry[$name])) $target[$name] = $entry[$name];
    return json_encode($target, JSON_THROW_ON_ERROR);
}

function playgroundDataReferences($value, array $results)
{
    if (!is_array($value)) return $value;
    if (array_key_exists('$ref', $value)) {
        $field = $value['field'] ?? 'id';
        $result = $results[$value['$ref']] ?? null;
        if (!in_array($field, ['id', 'guid'], true) || !$result || ($result['status'] ?? null) !== 'applied' || empty($result[$field])) {
            throw new RuntimeException('Referenced deployment record ' . (string) $value['$ref'] . ' is unavailable.');
        }
        return $result[$field];
    }
    foreach ($value as $key => $item) $value[$key] = playgroundDataReferences($item, $results);
    return $value;
}

function playgroundDataDependencies($value): array
{
    if (!is_array($value)) return [];
    if (isset($value['$ref'])) return [(string) $value['$ref']];
    $dependencies = [];
    foreach ($value as $item) $dependencies = array_merge($dependencies, playgroundDataDependencies($item));
    return array_values(array_unique($dependencies));
}

/** Queries are restricted to the table and columns returned by the installed native model. */
function playgroundDataFind($database, $table, array $match): int
{
    if (!$match) return 0;
    $columns = $table->getFields();
    $query = $database->getQuery(true)->select($database->quoteName($table->getKeyName()))->from($database->quoteName($table->getTableName()));
    foreach ($match as $column => $value) {
        if (!isset($columns[$column]) || (!is_scalar($value) && $value !== null)) throw new InvalidArgumentException('A record match must use existing scalar columns.');
        $query->where($database->quoteName($column) . ($value === null ? ' IS NULL' : ' = ' . $database->quote((string) $value)));
    }
    $ids = $database->setQuery($query, 0, 2)->loadColumn();
    if (count($ids) > 1) throw new RuntimeException('The record match is ambiguous; select unique identifying fields.');
    return (int) ($ids[0] ?? 0);
}

/** Native JCB metadata includes encoding and portable relationship information. */
function playgroundDataJcbFields(string $component, string $view): ?array
{
    if ($component !== 'com_componentbuilder' || !class_exists(\VDM\Joomla\Componentbuilder\Table::class)) return null;
    return (new \VDM\Joomla\Componentbuilder\Table())->fields($view, true, true);
}

/** Describe the native Joomla form as ordinary JSON Schema for deployment editors. */
function playgroundDataSchema($form, ?array $metadata = null, bool $componentParams = false): array
{
    $schema = ['type' => 'object', 'properties' => [], 'required' => []];
    if (!$form) return $schema;
    $seen = [];
    foreach ($form->getFieldsets() as $fieldset) {
        foreach ($form->getFieldset($fieldset->name) as $field) {
            $name = $field->fieldname;
            $type = strtolower($field->type);
            $group = (string) $field->group;
            $identity = $group . '.' . $name;
            if (isset($seen[$identity])) continue;
            $seen[$identity] = true;
            if (in_array($type, ['hidden', 'note', 'spacer', 'rules'], true) || !array_key_exists($name, playgroundDataPortableFields([$name => 1]))) continue;
            if (strtolower((string) $field->getAttribute('filter', '')) === 'unset' || (string) $field->getAttribute('disabled', '') === 'true') continue;
            $property = ['type' => 'string', 'title' => \Joomla\CMS\Language\Text::_((string) ($field->getAttribute('label') ?: $name))];
            $description = \Joomla\CMS\Language\Text::_((string) $field->getAttribute('description', ''));
            if ($description !== '') $property['description'] = strip_tags($description);
            $filter = strtolower((string) $field->getAttribute('filter', ''));
            if (in_array($filter, ['int', 'integer', 'uint'], true) || $type === 'number') $property['type'] = 'integer';
            if (in_array($filter, ['float', 'double'], true)) $property['type'] = 'number';
            if ($type === 'password') $property['format'] = 'password';
            if ($type === 'textarea' || $type === 'editor') $property['format'] = 'textarea';
            if ($type === 'email' || $type === 'url') $property['format'] = $type === 'url' ? 'uri' : 'email';
            if ($type === 'subform') $property = ['type' => 'object', 'title' => $property['title'], 'additionalProperties' => true];
            if ($type === 'checkbox') $property['type'] = 'boolean';
            if (in_array($type, ['list', 'radio'], true)) {
                $options = [];
                foreach (($field->options ?? []) as $option) {
                    $value = (string) $option->value;
                    if ($value === '') continue;
                    $options[] = ['const' => $property['type'] === 'integer' ? (int) $value : $value, 'title' => \Joomla\CMS\Language\Text::_((string) $option->text)];
                }
                if ($options) $property['oneOf'] = $options;
            }
            if ((string) $field->getAttribute('multiple', '') === 'true') {
                $property = ['type' => 'array', 'title' => $property['title'], 'items' => $property];
            }
            $default = $field->getAttribute('default');
            if ($default !== null && $default !== '' && in_array($property['type'], ['integer', 'number', 'string'], true)) {
                $property['default'] = $property['type'] === 'integer' ? (int) $default : ($property['type'] === 'number' ? (float) $default : (string) $default);
            }
            if (isset($metadata[$name]['link'])) $property['x-joomla-link'] = $metadata[$name]['link'];
            $groups = $group === '' ? [] : explode('.', $group);
            if ($componentParams && ($groups[0] ?? '') !== 'params') array_unshift($groups, 'params');
            $node =& $schema;
            foreach ($groups as $part) {
                $node['properties'][$part] ??= ['type' => 'object', 'title' => ucfirst($part), 'properties' => [], 'required' => []];
                $node =& $node['properties'][$part];
            }
            $node['properties'][$name] = $property;
            if ((string) $field->getAttribute('required', '') === 'true' && !(string) $field->getAttribute('showon', '')) $node['required'][] = $name;
            unset($node);
        }
    }
    // An empty properties map must serialize as an object, not a JSON array.
    if (!$schema['properties']) $schema['properties'] = new \stdClass();
    return $schema;
}

function playgroundDataValidate($model, array $values, bool $params = false): array
{
    $form = $model->getForm($params ? ($values['params'] ?? []) : $values, false);
    if (!$form) throw new RuntimeException('The native administrator form is unavailable.');
    $valid = $model->validate($form, $params ? ($values['params'] ?? []) : $values);
    if ($valid === false) {
        $errors = array_map(static fn($error) => $error instanceof Throwable ? $error->getMessage() : (string) $error, $model->getErrors());
        throw new RuntimeException('Native form validation failed: ' . implode('; ', array_slice($errors, 0, 5)));
    }
    return $params ? array_replace($values, ['params' => $valid]) : $valid;
}

function playgroundDataRedact(string $message, array $values): string
{
    $secrets = [];
    $walk = static function ($value, string $key = '') use (&$walk, &$secrets): void {
        if (is_array($value)) { foreach ($value as $name => $item) $walk($item, (string) $name); }
        elseif (is_string($value) && $value !== '' && preg_match('/token|password|secret|authorization|cookie|private_key/i', $key)) $secrets[] = $value;
    };
    $walk($values);
    foreach ($secrets as $secret) $message = str_replace($secret, '[redacted]', $message);
    return $message;
}

/** Resolve an extension setting or saved record through its native Joomla model. */
function playgroundDataContext(array $entry, array $bindings, $application, $database, $user, ?int $captureId = null): array
{
    $kind = $entry['kind'] ?? 'record';
    $id = 0;
    $metadata = null;
    if ($kind === 'component' || $kind === 'plugin') {
        $table = new \Joomla\CMS\Table\Extension($database);
        $identity = ['type' => $kind];
        if ($kind === 'component') {
            $identity['element'] = playgroundDataIdentifier($entry['component'] ?? null, 'component', '/^com_[a-z0-9_]+$/');
            $model = playgroundDataModel($application, $database, $user, 'com_config', 'component');
            $model->setState('component.option', $identity['element']);
        } else {
            $identity['folder'] = playgroundDataIdentifier($entry['folder'] ?? null, 'plugin group');
            $identity['element'] = playgroundDataIdentifier($entry['element'] ?? null, 'plugin element');
            $model = playgroundDataModel($application, $database, $user, 'com_plugins', 'plugin');
        }
        if (!$table->load($identity)) throw new RuntimeException('The configured extension is not installed.');
        $id = (int) $table->extension_id;
        if ($captureId !== null && $captureId !== $id) throw new RuntimeException('The selected extension does not match the saved record.');
        $data = $kind === 'plugin' ? (array) $model->getItem($id) : $table->getProperties();
        $data['params'] = (new \Joomla\Registry\Registry($data['params'] ?? '{}'))->toArray();
        if ($kind === 'plugin') $model->setState('plugin.id', $id);
    } elseif ($kind === 'module') {
        $element = playgroundDataIdentifier($entry['element'] ?? null, 'module element', '/^mod_[a-z0-9_]+$/');
        $client = $entry['clientId'] ?? 0;
        if (!in_array($client, [0, 1], true)) throw new InvalidArgumentException('A module client must be 0 or 1.');
        $extension = new \Joomla\CMS\Table\Extension($database);
        if (!$extension->load(['type' => 'module', 'element' => $element, 'client_id' => $client])) throw new RuntimeException('The module extension is not installed.');
        $model = playgroundDataModel($application, $database, $user, 'com_modules', 'module');
        $table = $model->getTable();
        $match = array_replace($entry['match'] ?? [], ['module' => $element, 'client_id' => $client]);
        $binding = $bindings[$entry['key'] ?? ''] ?? null;
        $id = $captureId ?? (!empty($entry['match']) ? playgroundDataFind($database, $table, $match) : (($binding['target'] ?? '') === playgroundDataTarget($entry) ? (int) ($binding['id'] ?? 0) : 0));
        if ($id && (!$table->load($id) || $table->module !== $element || (int) $table->client_id !== $client)) throw new RuntimeException('The saved module identity does not match this deployment entry.');
        $model->setState('module.id', $id);
        $application->getInput()->set('client_id', $client);
        $data = $id ? (array) $model->getItem($id) : ['id' => 0, 'module' => $element, 'client_id' => $client, 'published' => 1, 'access' => 1, 'showtitle' => 1, 'language' => '*', 'position' => '', 'params' => [], 'assignment' => 0];
    } elseif ($kind === 'record') {
        $component = playgroundDataIdentifier($entry['component'] ?? null, 'component', '/^com_[a-z0-9_]+$/');
        $view = playgroundDataIdentifier($entry['view'] ?? null, 'administrator view');
        if ($component === 'com_componentbuilder' && in_array($view, ['server', 'servers'], true)) throw new RuntimeException('JCB Server configuration is not supported by deployment overlays.');
        $model = playgroundDataModel($application, $database, $user, $component, $view);
        $table = $model->getTable();
        $metadata = playgroundDataJcbFields($component, $view);
        $columns = $table->getFields();
        $guid = $entry['guid'] ?? null;
        if ($guid !== null && (!is_string($guid) || !preg_match('/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i', $guid) || !isset($columns['guid']))) {
            throw new RuntimeException('This administrator view does not accept the supplied GUID identity.');
        }
        $binding = $bindings[$entry['key'] ?? ''] ?? null;
        $id = $captureId ?? ($guid ? playgroundDataFind($database, $table, ['guid' => $guid]) : (!empty($entry['match']) ? playgroundDataFind($database, $table, $entry['match']) : (($binding['target'] ?? '') === playgroundDataTarget($entry) ? (int) ($binding['id'] ?? 0) : 0)));
        if ($id && !$table->load($id)) throw new RuntimeException('The previously bound record no longer exists.');
        $model->setState($view . '.id', $id);
        $application->getInput()->set('id', $id);
        $data = $id ? (array) $model->getItem($id) : ['id' => 0];
        if ($guid !== null) $data['guid'] = $guid;
    } else {
        throw new InvalidArgumentException('Unknown configuration overlay kind.');
    }
    return compact('kind', 'id', 'model', 'table', 'data', 'metadata');
}

/** Apply the table's own form validation and storage path; data is never executed as SQL or PHP. */
function playgroundDataApply(array $entry, array $bindings, $application, $database, $user): array
{
    $context = playgroundDataContext($entry, $bindings, $application, $database, $user);
    extract($context);
    $fields = $entry['fields'] ?? [];
    if (!is_array($fields)) throw new InvalidArgumentException('Overlay fields must be an object.');
    if (array_intersect(array_keys($fields), ['id', 'guid', 'extension_id', 'asset_id', 'checked_out', 'checked_out_time'])) {
        throw new InvalidArgumentException('Use the overlay identity, not database identity fields.');
    }
    $needsRemote = !$id || ($entry['source']['refresh'] ?? false);
    if (!$id && $fields && !isset($entry['source'])) {
        // Complete values can create a local record without contacting a remote repository.
        // Incomplete values may still be an overlay on top of a remotely published GUID.
        try {
            playgroundDataValidate($model, playgroundDataMerge($data, $fields));
            $needsRemote = false;
        } catch (Throwable $error) {
            $needsRemote = true;
        }
    }
    if ($kind === 'record' && ($entry['component'] ?? '') === 'com_componentbuilder' && !empty($entry['guid']) && $needsRemote) {
        $factory = \VDM\Joomla\Componentbuilder\Factory::class;
        if (!class_exists($factory) || !$factory::getArea($entry['view'])) throw new RuntimeException('This JCB view has no remote GUID retrieval capability.');
        \VDM\Joomla\Utilities\Component\Helper::setOption('com_componentbuilder');
        $get = $factory::_($entry['view'], 'Package.Builder.Get');
        $repository = $entry['source']['repository'] ?? null;
        if (is_string($repository)) {
            $repository = \VDM\Joomla\Componentbuilder\Utilities\RepoHelper::getRepo($repository);
            if (!$repository) throw new RuntimeException('The source repository must be configured before dependent GUID retrieval.');
        } elseif (is_array($repository)) {
            $repository = (object) $repository;
            if (isset($repository->type)) $repository->target = (int) $repository->type === 2 ? 'github' : 'gitea';
        }
        if ($repository !== null && !$get->validRepo($entry['view'], $repository)) throw new RuntimeException('The source repository is not valid for this JCB view.');
        $get->init($entry['view'], [$entry['guid']], $repository, (bool) ($entry['source']['refresh'] ?? false));
        $context = playgroundDataContext($entry, $bindings, $application, $database, $user);
        extract($context);
        if (!$id && !$fields) throw new RuntimeException('The requested GUID could not be retrieved from the configured repositories.');
    }
    if (!$fields) {
        if (!$id) throw new RuntimeException('No saved record was found and no values were supplied to create one.');
        return ['id' => $id] + (!empty($data['guid']) ? ['guid' => $data['guid']] : []);
    }
    if ($kind === 'component' || $kind === 'plugin') {
        $allowed = $kind === 'component' ? ['params'] : ['params', 'enabled', 'ordering', 'access'];
        if (array_diff(array_keys($fields), $allowed)) throw new InvalidArgumentException('This extension settings entry contains unsupported fields.');
    }
    if ($kind === 'module') {
        foreach (['module', 'client_id'] as $identity) if (array_key_exists($identity, $fields) && $fields[$identity] !== $data[$identity]) throw new InvalidArgumentException('Module identity cannot be changed through fields.');
    }
    $values = playgroundDataMerge($data, $fields);
    if ($kind === 'record') {
        $nativeForm = $model->getForm($values, false);
        foreach ($fields as $name => $value) {
            if (!$nativeForm || !$nativeForm->getField($name)) throw new InvalidArgumentException('The native administrator form does not support field ' . $name . '.');
        }
    }
    if ($kind === 'component') {
        $values = ['id' => $id, 'option' => $entry['component'], 'params' => $values['params']];
        $valid = playgroundDataValidate($model, $values, true);
    } else {
        $valid = playgroundDataValidate($model, $values);
        // Joomla filters identity fields in forms; the locally resolved key remains authoritative.
        $valid[$table->getKeyName()] = $id;
        if ($kind === 'module') {
            $valid['module'] = $values['module'];
            $valid['client_id'] = $values['client_id'];
            // Preserve current menu assignments when the overlay does not change them.
            foreach (['assignment', 'assigned'] as $name) if (!array_key_exists($name, $valid) && isset($values[$name])) $valid[$name] = $values[$name];
        }
    }
    $useDataItem = $kind === 'record' && ($entry['component'] ?? '') === 'com_componentbuilder' && $metadata && isset($metadata['guid']) && class_exists(\VDM\Joomla\Componentbuilder\Factory::class)
        && \VDM\Joomla\Componentbuilder\Factory::getArea($entry['view']);
    foreach ($metadata ?? [] as $definition) if (!empty($definition['store']) && !in_array($definition['store'], ['base64', 'json'], true)) $useDataItem = false;
    if ($useDataItem) {
        foreach ($fields as $value) if ($value === null) throw new InvalidArgumentException('Use an empty value to clear a JCB field; this native data adapter does not write NULL.');
        \VDM\Joomla\Utilities\Component\Helper::setOption('com_componentbuilder');
        $item = \VDM\Joomla\Componentbuilder\Factory::_($entry['view'], 'Data.Item');
        $guid = $entry['guid'] ?? $data['guid'] ?? \VDM\Joomla\Utilities\GuidHelper::get();
        $write = $id ? array_intersect_key($valid, $fields) : playgroundDataPortableFields($valid);
        $write['guid'] = $guid;
        if (!$item->table($entry['view'])->set((object) $write, 'guid')) throw new RuntimeException('JCB could not save the configuration record.');
        $stored = $item->table($entry['view'])->get($guid, 'guid');
        if (!$stored || empty($stored->id)) throw new RuntimeException('JCB did not return the saved record identity.');
        return ['id' => (int) $stored->id, 'guid' => $guid];
    }
    if (!$model->save($valid)) throw new RuntimeException('The native administrator model could not save this configuration: ' . $model->getError());
    $savedId = $kind === 'component' || $kind === 'plugin' ? $id : (int) $model->getState($model->getName() . '.id', $id);
    if (!$savedId) throw new RuntimeException('The native model did not return the saved record identity.');
    $stored = $kind === 'component' ? $values : (array) $model->getItem($savedId);
    return ['id' => $savedId] + (!empty($stored['guid']) ? ['guid' => $stored['guid']] : []);
}
