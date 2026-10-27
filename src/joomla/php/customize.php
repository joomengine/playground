<?php
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $selected = $playground['language'] ?? 'en-GB';
    $content = $playground['content'] ?? null;
    $tags = [$selected];
    foreach ($content['categories'] ?? [] as $entry) {
        $tags[] = $entry['language'];
    }
    $tags = array_values(array_unique($tags));
    $siteLanguages = \Joomla\CMS\Language\LanguageHelper::getInstalledLanguages(0, true);
    $adminLanguages = \Joomla\CMS\Language\LanguageHelper::getInstalledLanguages(1, true);
    foreach ($tags as $tag) {
        if (!isset($siteLanguages[$tag]) || !isset($adminLanguages[$tag])) {
            throw new RuntimeException('Install the site and administrator language package for ' . $tag . ' before selecting it.');
        }
    }
    $languageComponent = new \Joomla\CMS\Table\Extension($database);
    if (!$languageComponent->load(['type' => 'component', 'element' => 'com_languages'])) {
        throw new RuntimeException('Joomla language configuration is unavailable.');
    }
    $parameters = new \Joomla\Registry\Registry($languageComponent->params);
    $parameters->set('site', $selected);
    $parameters->set('administrator', $selected);
    playgroundStoreTable($languageComponent, ['params' => (string) $parameters]);

    $created = ['categories' => [], 'articles' => [], 'menus' => []];
    if ($content !== null) {
        foreach ($tags as $tag) {
            $metadata = $siteLanguages[$tag]->metadata;
            $table = new \Joomla\CMS\Table\Language($database);
            $exists = $table->load(['lang_code' => $tag]);
            $sef = $exists ? $table->sef : strtolower(explode('-', $tag)[0]);
            $occupied = $database->setQuery(
                'SELECT lang_code FROM #__languages WHERE sef = ' . $database->quote($sef)
                . ' AND lang_code <> ' . $database->quote($tag)
            )->loadResult();
            if ($occupied) {
                $sef = strtolower($tag);
            }
            playgroundStoreTable($table, [
                'lang_code' => $tag, 'title' => $metadata['name'],
                'title_native' => $metadata['nativeName'] ?? $metadata['name'],
                'sef' => $sef, 'image' => strtolower(str_replace('-', '_', $tag)),
                'description' => '', 'published' => 1, 'access' => 1,
                'ordering' => $exists ? $table->ordering : 0,
            ]);
        }
        if ($content['multilingual']) {
            foreach (['languagefilter', 'languagecode'] as $element) {
                $plugin = new \Joomla\CMS\Table\Extension($database);
                if (!$plugin->load(['type' => 'plugin', 'folder' => 'system', 'element' => $element])) {
                    throw new RuntimeException('Joomla language plugin is unavailable: ' . $element);
                }
                $parameters = new \Joomla\Registry\Registry($plugin->params);
                if ($element === 'languagefilter') {
                    $parameters->set('detect_browser', 0);
                    $parameters->set('automatic_change', 1);
                    $parameters->set('item_associations', 1);
                    $parameters->set('remove_default_prefix', 0);
                }
                playgroundStoreTable($plugin, ['enabled' => 1, 'params' => (string) $parameters]);
            }
        }
        $username = $playground['admin']['username'];
        $administratorId = (int) $database->setQuery(
            'SELECT id FROM #__users WHERE username = ' . $database->quote($username)
        )->loadResult();
        $administrator = $container->get(\Joomla\CMS\User\UserFactoryInterface::class)->loadUserById($administratorId);
        if (!$administrator->authorise('core.admin')) {
            throw new RuntimeException('The configured administrator cannot provision blueprint content.');
        }
        $application->loadIdentity($administrator);
        foreach ($content['categories'] as $entry) {
            $category = new \Joomla\CMS\Table\Category($database);
            $category->setCurrentUser($administrator);
            $category->setLocation(1, 'last-child');
            playgroundStoreTable($category, [
                'parent_id' => 1, 'extension' => 'com_content', 'title' => $entry['title'],
                'alias' => $entry['alias'], 'language' => $entry['language'], 'published' => 1,
                'access' => 1, 'description' => '', 'params' => '{}', 'metadata' => '{}',
                'created_user_id' => $administratorId,
            ]);
            $created['categories'][$entry['key']] = (int) $category->id;
        }
        $componentId = (int) $database->setQuery("SELECT extension_id FROM #__extensions WHERE type = 'component' AND element = 'com_content'")->loadResult();
        define('JPATH_COMPONENT', JPATH_ADMINISTRATOR . '/components/com_content');
        define('JPATH_COMPONENT_ADMINISTRATOR', JPATH_COMPONENT);
        define('JPATH_COMPONENT_SITE', JPATH_SITE . '/components/com_content');
        foreach ($content['articles'] as $entry) {
            $model = $application->bootComponent('com_content')->getMVCFactory()->createModel('Article', 'Administrator', ['ignore_request' => true]);
            $model->setCurrentUser($administrator);
            if (!$model->save([
                'id' => 0, 'title' => $entry['title'], 'alias' => $entry['alias'],
                'catid' => $created['categories'][$entry['category']], 'language' => $entry['language'],
                'introtext' => $entry['introtext'], 'fulltext' => $entry['fulltext'],
                'state' => 1, 'access' => 1, 'created_by' => $administratorId,
                'featured' => $entry['featured'] ? 1 : 0, 'images' => '{}', 'urls' => '{}',
                'attribs' => '{}', 'metadata' => '{}',
            ])) {
                throw new RuntimeException('Cannot create blueprint article: ' . $model->getError());
            }
            $articleId = (int) $model->getState('article.id');
            $created['articles'][$entry['key']] = $articleId;
            if ($entry['home']) {
                $menuType = 'playground-' . strtolower($entry['language']);
                $type = new \Joomla\CMS\Table\MenuType($database);
                if (!$type->load(['menutype' => $menuType])) {
                    playgroundStoreTable($type, [
                        'menutype' => $menuType, 'title' => $entry['title'],
                        'description' => 'Blueprint navigation', 'client_id' => 0,
                    ]);
                }
                $menu = new \Joomla\CMS\Table\Menu($database);
                $menu->setLocation(1, 'last-child');
                playgroundStoreTable($menu, [
                    'menutype' => $menuType, 'title' => $entry['title'], 'alias' => $entry['alias'],
                    'type' => 'component', 'link' => 'index.php?option=com_content&view=article&id=' . $articleId,
                    'component_id' => $componentId, 'published' => 1, 'parent_id' => 1,
                    'home' => 1, 'language' => $content['multilingual'] ? $entry['language'] : '*',
                    'client_id' => 0, 'access' => 1, 'params' => '{}',
                ]);
                $created['menus'][$entry['language']] = (int) $menu->id;
            }
        }
        if ($content['multilingual']) {
            $module = new \Joomla\CMS\Table\Module($database);
            playgroundStoreTable($module, [
                'title' => 'Languages', 'module' => 'mod_languages', 'position' => 'topbar',
                'content' => '', 'published' => 1, 'showtitle' => 0, 'access' => 1,
                'client_id' => 0, 'language' => '*',
                'params' => ['cache' => 0, 'dropdown' => 0, 'full_name' => 1, 'images' => 0, 'inline' => 1, 'show_active' => 1],
            ]);
            $assignment = (object) ['moduleid' => (int) $module->id, 'menuid' => 0];
            if (!$database->insertObject('#__modules_menu', $assignment)) {
                throw new RuntimeException('Cannot publish the language switcher module.');
            }
        }
    }
    playgroundFinish(['ok' => true, 'language' => $selected, 'content' => $created]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
