<?php
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $selected = $playground['language'] ?? 'en-GB';
    $content = $playground['content'] ?? null;
    $multilingual = $playground['multilingual'] ?? $content['multilingual'] ?? false;
    $configureLanguage = $playground['configureLanguage'] ?? true;
    $bindings = $playground['contentBindings'] ?? [];
    $references = [];
    foreach (['categories', 'articles'] as $kind) {
        foreach ($playground['contentReferences'][$kind] ?? [] as $entry) $references[$kind][$entry['key']] = $entry;
    }
    $tags = [$selected, ...($playground['languageTags'] ?? [])];
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
    if ($configureLanguage) {
        $languageComponent = new \Joomla\CMS\Table\Extension($database);
        if (!$languageComponent->load(['type' => 'component', 'element' => 'com_languages'])) {
            throw new RuntimeException('Joomla language configuration is unavailable.');
        }
        $parameters = new \Joomla\Registry\Registry($languageComponent->params);
        $parameters->set('site', $selected);
        $parameters->set('administrator', $selected);
        playgroundStoreTable($languageComponent, ['params' => (string) $parameters]);
        if (array_key_exists('multilingual', $playground)) {
            foreach (['languagefilter', 'languagecode'] as $element) {
                $plugin = new \Joomla\CMS\Table\Extension($database);
                if (!$plugin->load(['type' => 'plugin', 'folder' => 'system', 'element' => $element])) {
                    throw new RuntimeException('Joomla language plugin is unavailable: ' . $element);
                }
                $parameters = new \Joomla\Registry\Registry($plugin->params);
                if ($multilingual && $element === 'languagefilter') {
                    $parameters->set('detect_browser', 0);
                    $parameters->set('automatic_change', 1);
                    $parameters->set('item_associations', 1);
                    $parameters->set('remove_default_prefix', 0);
                }
                playgroundStoreTable($plugin, ['enabled' => $multilingual ? 1 : 0, 'params' => (string) $parameters]);
            }
            if (!$multilingual) {
                $module = new \Joomla\CMS\Table\Module($database);
                if ($module->load(['module' => 'mod_languages', 'client_id' => 0, 'language' => '*'])) {
                    playgroundStoreTable($module, ['published' => 0]);
                }
            }
        }
    }

    $created = ['categories' => [], 'articles' => [], 'menus' => []];
    if ($content !== null || ($configureLanguage && $multilingual)) {
        foreach ($tags as $languageOrder => $tag) {
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
                'ordering' => $languageOrder + 1,
            ]);
        }
        $username = $playground['admin']['username'];
        $administratorId = (int) $database->setQuery(
            'SELECT id FROM #__users WHERE username = ' . $database->quote($username)
        )->loadResult();
        $administrator = $container->get(\Joomla\CMS\User\UserFactoryInterface::class)->loadUserById($administratorId);
        if (!$administrator->authorise('core.admin')) {
            throw new RuntimeException('The configured administrator cannot provision deploy content.');
        }
        $application->loadIdentity($administrator);
        foreach ($content['categories'] ?? [] as $entry) {
            $category = new \Joomla\CMS\Table\Category($database);
            $category->setCurrentUser($administrator);
            $reference = $references['categories'][$entry['key']] ?? $entry;
            $id = (int) ($bindings['categories'][$entry['key']] ?? 0);
            if ($id) $category->load($id);
            if (!$category->id) $category->load(['extension' => 'com_content', 'alias' => $reference['alias'], 'language' => $reference['language']]);
            if (!$category->id) $category->setLocation(1, 'last-child');
            playgroundStoreTable($category, [
                'extension' => 'com_content', 'title' => $entry['title'],
                'alias' => $entry['alias'], 'language' => $entry['language'],
            ] + ($category->id ? [] : [
                'parent_id' => 1, 'published' => 1,
                'access' => 1, 'description' => '', 'params' => '{}', 'metadata' => '{}',
                'created_user_id' => $administratorId,
            ]));
            $created['categories'][$entry['key']] = (int) $category->id;
        }
        $componentId = (int) $database->setQuery("SELECT extension_id FROM #__extensions WHERE type = 'component' AND element = 'com_content'")->loadResult();
        define('JPATH_COMPONENT', JPATH_ADMINISTRATOR . '/components/com_content');
        define('JPATH_COMPONENT_ADMINISTRATOR', JPATH_COMPONENT);
        define('JPATH_COMPONENT_SITE', JPATH_SITE . '/components/com_content');
        foreach ($content['articles'] ?? [] as $entry) {
            $reference = $references['articles'][$entry['key']] ?? $entry;
            $articleId = (int) ($bindings['articles'][$entry['key']] ?? 0);
            $table = new \Joomla\CMS\Table\Content($database);
            if (!$articleId || !$table->load($articleId)) {
                $category = $references['categories'][$reference['category']] ?? null;
                $categoryId = $created['categories'][$reference['category']] ?? 0;
                if (!$categoryId && $category) {
                    $categoryId = (int) $database->setQuery('SELECT id FROM #__categories WHERE extension = \'com_content\' AND alias = ' . $database->quote($category['alias']) . ' AND language = ' . $database->quote($category['language']))->loadResult();
                }
                $categoryId = $categoryId ?: $created['categories'][$entry['category']];
                $table->load(['alias' => $reference['alias'], 'catid' => $categoryId, 'language' => $reference['language']]);
                $articleId = (int) $table->id;
            }
            $model = $application->bootComponent('com_content')->getMVCFactory()->createModel('Article', 'Administrator', ['ignore_request' => true]);
            $model->setCurrentUser($administrator);
            if (!$model->save([
                'id' => $articleId, 'title' => $entry['title'], 'alias' => $entry['alias'],
                'catid' => $created['categories'][$entry['category']], 'language' => $entry['language'],
                'introtext' => $entry['introtext'], 'fulltext' => $entry['fulltext'],
                'featured' => $entry['featured'] ? 1 : 0,
            ] + ($articleId ? [] : [
                'state' => 1, 'access' => 1, 'created_by' => $administratorId,
                'images' => '{}', 'urls' => '{}',
                'attribs' => '{}', 'metadata' => '{}',
            ]))) {
                throw new RuntimeException('Cannot save deploy article: ' . $model->getError());
            }
            $articleId = (int) $model->getState('article.id');
            $created['articles'][$entry['key']] = $articleId;
            if ($entry['home']) {
                $menuType = 'playground-' . strtolower($entry['language']);
                $type = new \Joomla\CMS\Table\MenuType($database);
                if (!$type->load(['menutype' => $menuType])) {
                    playgroundStoreTable($type, [
                        'menutype' => $menuType, 'title' => $entry['title'],
                        'description' => 'Deploy navigation', 'client_id' => 0,
                    ]);
                }
                $menu = new \Joomla\CMS\Table\Menu($database);
                $menuId = (int) ($bindings['menus'][$entry['language']] ?? 0);
                if ($menuId) $menu->load($menuId);
                if (!$menu->id) $menu->load(['menutype' => 'playground-' . strtolower($reference['language']),
                    'link' => 'index.php?option=com_content&view=article&id=' . $articleId]);
                if (!$menu->id) $menu->setLocation(1, 'last-child');
                playgroundStoreTable($menu, [
                    'menutype' => $menuType, 'title' => $entry['title'], 'alias' => $entry['alias'],
                    'type' => 'component', 'link' => 'index.php?option=com_content&view=article&id=' . $articleId,
                    'component_id' => $componentId, 'published' => 1, 'parent_id' => 1,
                    'home' => 1, 'language' => $multilingual ? $entry['language'] : '*',
                    'client_id' => 0, 'access' => 1, 'params' => '{}',
                ]);
                $created['menus'][$entry['language']] = (int) $menu->id;
            }
        }
        if ($multilingual && count($created['menus']) > 1) {
            foreach ($created['menus'] as $tag => $id) {
                $model = $application->bootComponent('com_menus')->getMVCFactory()->createModel('Item', 'Administrator', ['ignore_request' => true]);
                $model->setCurrentUser($administrator);
                $data = (array) $model->getItem($id);
                $data['menuordering'] = 0;
                $data['associations'] = array_diff_key($created['menus'], [$tag => true]);
                if (!$model->save($data)) throw new RuntimeException('Cannot associate language home pages: ' . $model->getError());
            }
        }
        if ($configureLanguage && $multilingual) {
            $module = new \Joomla\CMS\Table\Module($database);
            $module->load(['module' => 'mod_languages', 'client_id' => 0, 'language' => '*']);
            playgroundStoreTable($module, [
                'title' => 'Languages', 'module' => 'mod_languages', 'position' => 'topbar',
                'content' => '', 'published' => 1, 'showtitle' => 0, 'access' => 1,
                'client_id' => 0, 'language' => '*',
                'params' => ['cache' => 0, 'dropdown' => 0, 'full_name' => 1, 'images' => 0, 'inline' => 1, 'show_active' => 1],
            ]);
            $assignment = (object) ['moduleid' => (int) $module->id, 'menuid' => 0];
            $assigned = (int) $database->setQuery('SELECT COUNT(*) FROM #__modules_menu WHERE moduleid = ' . (int) $module->id . ' AND menuid = 0')->loadResult();
            if (!$assigned && !$database->insertObject('#__modules_menu', $assignment)) {
                throw new RuntimeException('Cannot publish the language switcher module.');
            }
        }
    }
    playgroundFinish(['ok' => true, 'version' => JVERSION, 'siteName' => $application->get('sitename'), 'language' => $selected, 'content' => $created]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
