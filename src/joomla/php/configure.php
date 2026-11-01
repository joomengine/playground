<?php
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $administratorPath = dirname($root) . '/meta/administrator.json';
    if (!is_file($administratorPath)) {
        throw new RuntimeException('The saved administrator identity is unavailable.');
    }
    $credentials = json_decode(file_get_contents($administratorPath), true, 512, JSON_THROW_ON_ERROR);
    $username = $credentials['administrator']['username'] ?? null;
    $administratorId = (int) $database->setQuery('SELECT id FROM #__users WHERE username = ' . $database->quote($username ?? ''))->loadResult();
    $administrator = $container->get(\Joomla\CMS\User\UserFactoryInterface::class)->loadUserById($administratorId);
    if (!$administrator->authorise('core.admin')) {
        throw new RuntimeException('The configured administrator cannot change site menus or templates.');
    }
    $application->loadIdentity($administrator);
    if (!defined('JPATH_COMPONENT')) define('JPATH_COMPONENT', $root . '/administrator/components/com_menus');
    \Joomla\CMS\Form\Form::addFormPath($root . '/administrator/components/com_menus/forms');
    \Joomla\CMS\Form\Form::addFormPath($root . '/administrator/components/com_templates/forms');
    $menuFactory = $application->bootComponent('com_menus')->getMVCFactory();
    $created = [];
    $homes = [];
    $skipped = [];
    $warnings = [];
    $allowMissingDependencies = !empty($playground['allowMissingDependencies']);
    $warn = static function (string $package, string $message) use (&$warnings): void {
        $warnings[] = ['package' => $package, 'message' => $message];
    };
    foreach ($playground['menus'] ?? [] as $entry) {
        $component = $entry['component'];
        if (!preg_match('/^com_[a-z0-9_]+$/', $component)) {
            throw new RuntimeException('Invalid menu component.');
        }
        $componentId = (int) $database->setQuery("SELECT extension_id FROM #__extensions WHERE type = 'component' AND enabled = 1 AND element = " . $database->quote($component))->loadResult();
        if (!$componentId || !is_dir($root . '/components/' . $component)) {
            if ($allowMissingDependencies) {
                $skipped[$entry['key']] = true;
                $warn('Menu', 'Menu "' . $entry['title'] . '" was skipped because its component is unavailable: ' . $component . '.');
                continue;
            }
            throw new RuntimeException('Install the site component before creating its menu: ' . $component);
        }
        $view = $entry['view'];
        if (!preg_match('/^[a-z][a-z0-9_-]*$/', $view)) {
            throw new RuntimeException('Invalid component view.');
        }
        if (!is_dir($root . '/components/' . $component . '/tmpl/' . $view)
            && !is_dir($root . '/components/' . $component . '/views/' . $view)) {
            if ($allowMissingDependencies) {
                $skipped[$entry['key']] = true;
                $warn('Menu', 'Menu "' . $entry['title'] . '" was skipped because its component view is unavailable: ' . $component . '/' . $view . '.');
                continue;
            }
            throw new RuntimeException('The component does not provide this site view: ' . $component . '/' . $view);
        }
        $type = new \Joomla\CMS\Table\MenuType($database);
        if (!$type->load(['menutype' => $entry['menuType']])) {
            $menuModel = $menuFactory->createModel('Menu', 'Administrator', ['ignore_request' => true]);
            $menuModel->setCurrentUser($administrator);
            if (!$menuModel->save(['id' => 0, 'menutype' => $entry['menuType'], 'title' => $entry['menuType'], 'description' => 'Deployment navigation', 'client_id' => 0])) {
                throw new RuntimeException('Cannot create menu: ' . $menuModel->getError());
            }
        }
        $existing = (int) $database->setQuery('SELECT id FROM #__menu WHERE client_id = 0 AND menutype = ' . $database->quote($entry['menuType'])
            . ' AND alias = ' . $database->quote($entry['alias']) . ' AND language = ' . $database->quote($entry['language']))->loadResult();
        $currentHome = $existing ? (int) $database->setQuery('SELECT home FROM #__menu WHERE id = ' . $existing)->loadResult() : 0;
        $query = ['option' => $component, 'view' => $view] + ($entry['query'] ?? []);
        $link = 'index.php?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        $model = $menuFactory->createModel('Item', 'Administrator', ['ignore_request' => true]);
        $model->setCurrentUser($administrator);
        $model->setState('item.type', 'component');
        $model->setState('item.link', $link);
        $model->setState('item.client_id', 0);
        $model->setState('item.menutype', $entry['menuType']);
        $model->setState('item.id', $existing);
        $data = [
            'id' => $existing, 'menutype' => $entry['menuType'], 'title' => $entry['title'], 'alias' => $entry['alias'],
            'type' => 'component', 'link' => $link, 'component_id' => $componentId, 'parent_id' => 1,
            'menuordering' => -2, 'published' => $entry['published'] ? 1 : 0, 'language' => $entry['language'],
            'client_id' => 0, 'access' => $entry['access'], 'template_style_id' => $entry['templateStyle'],
            'params' => $entry['params'], 'request' => $query, 'home' => $currentHome,
        ];
        if ($entry['templateStyle'] && !(int) $database->setQuery('SELECT id FROM #__template_styles WHERE client_id = 0 AND id = ' . (int) $entry['templateStyle'])->loadResult()) {
            if (!$allowMissingDependencies) throw new RuntimeException('The selected menu template style does not exist.');
            $data['template_style_id'] = 0;
            $warn('Menu', 'Menu "' . $entry['title'] . '" uses the current site template because its selected template style is unavailable.');
        }
        $form = $model->getForm($data, false);
        if (!$form || ($validated = $model->validate($form, $data)) === false) {
            throw new RuntimeException('Menu validation failed: ' . implode('; ', array_map('strval', $model->getErrors())));
        }
        if (!$model->save(array_replace($data, $validated))) {
            throw new RuntimeException('Cannot save menu item: ' . $model->getError());
        }
        $id = (int) $model->getState('item.id');
        $created[$entry['key']] = $id;
        if ($entry['home']) {
            $ids = [$id];
            if (!$model->setHome($ids, 1)) {
                throw new RuntimeException('Cannot set the home page: ' . $model->getError());
            }
            $homes[$entry['language']] = $id;
        }
    }
    if (count($homes) > 1 && !isset($homes['*'])) {
        $associations = $homes;
        foreach ($homes as $language => $id) {
            $model = $menuFactory->createModel('Item', 'Administrator', ['ignore_request' => true]);
            $model->setCurrentUser($administrator);
            $item = (array) $model->getItem($id);
            $item['menuordering'] = 0;
            $item['associations'] = array_diff_key($associations, [$language => true]);
            if (!$model->save($item)) throw new RuntimeException('Cannot associate language home pages: ' . $model->getError());
        }
    }
    $styleId = null;
    if (!empty($playground['template'])) {
        $template = $playground['template'];
        $query = 'SELECT * FROM #__template_styles WHERE client_id = 0';
        $query .= isset($template['styleId']) ? ' AND id = ' . (int) $template['styleId'] : ' AND template = ' . $database->quote($template['element']);
        $style = $database->setQuery($query . ' ORDER BY id ASC', 0, 1)->loadAssoc();
        if (!$style || (isset($template['element']) && $style['template'] !== $template['element'])) {
            if (empty($playground['optionalTemplate'])) throw new RuntimeException('Install the selected site template before configuring it.');
            $warn('Template', 'The selected custom template is unavailable. The current site template has been kept.');
            $style = null;
        }
        if ($style) {
            $styleId = (int) $style['id'];
            $model = $application->bootComponent('com_templates')->getMVCFactory()->createModel('Style', 'Administrator', ['ignore_request' => true]);
            $model->setCurrentUser($administrator);
            $model->setState('item.client_id', 0);
            $model->setState('item.template', $style['template']);
            $model->setState('style.id', $styleId);
            $parameters = new \Joomla\Registry\Registry($style['params']);
            foreach ($template['params'] ?? [] as $name => $value) $parameters->set($name, $value);
            $data = $style;
            $data['params'] = $parameters->toArray();
            if (!empty($template['menuKeys'])) {
                $data['assigned'] = [];
                foreach ($template['menuKeys'] as $key) {
                    if (isset($skipped[$key])) {
                        $warn('Template', 'A template assignment was skipped because its deployment menu is unavailable.');
                        continue;
                    }
                    if (!isset($created[$key])) throw new RuntimeException('Template assignment references an unknown deployment menu: ' . $key);
                    $data['assigned'][] = $created[$key];
                }
            }
            $form = $model->getForm($data, false);
            if (!$form || ($validated = $model->validate($form, $data)) === false) {
                throw new RuntimeException('Template settings are invalid: ' . implode('; ', array_map('strval', $model->getErrors())));
            }
            if (!$model->save(array_replace($data, $validated))) throw new RuntimeException('Cannot save template style: ' . $model->getError());
            if (empty($template['menuKeys']) && !$model->setHome($styleId)) throw new RuntimeException('Cannot select the default template: ' . $model->getError());
        }
    }
    if (!empty($playground['multilingual'])) {
        foreach ($playground['languageTags'] ?? [] as $tag) {
            $homeCount = (int) $database->setQuery('SELECT COUNT(*) FROM #__menu WHERE client_id = 0 AND home = 1 AND published = 1 AND language = ' . $database->quote($tag))->loadResult();
            if ($homeCount !== 1) {
                if (!$skipped) throw new RuntimeException('A multilingual deployment needs exactly one published home menu for ' . $tag . '.');
                $warn('Menu', 'The home menu for ' . $tag . ' could not be configured because a required extension is unavailable.');
            }
        }
    }
    if (array_key_exists('siteName', $playground)) {
        $name = $playground['siteName'];
        if (!is_string($name) || $name === '' || strlen($name) > 1024 || str_contains($name, "\0")) {
            throw new RuntimeException('The site name is invalid.');
        }
        $configuration = new \Joomla\Registry\Registry(new JConfig());
        $configuration->set('sitename', $name);
        $serialized = $configuration->toString('PHP', ['class' => 'JConfig', 'closingtag' => false]);
        $target = $root . '/configuration.php';
        $temporary = $root . '/configuration.rocket-' . bin2hex(random_bytes(8)) . '.php';
        $mode = fileperms($target) & 0777;
        try {
            if (file_put_contents($temporary, $serialized) !== strlen($serialized) || !chmod($temporary, $mode) || !rename($temporary, $target)) {
                throw new RuntimeException('Cannot save the site name.');
            }
        } finally {
            if (is_file($temporary)) unlink($temporary);
        }
    }
    playgroundFinish(['ok' => true, 'menus' => $created, 'templateStyle' => $styleId, 'warnings' => $warnings]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
