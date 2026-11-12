<?php
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $administrator = playgroundDataAdministrator($root, $playground, $application, $container, $database);
    playgroundDataLanguage($playground, $application, $container);
    // A selected target is described lazily; listing views never boots hundreds of models.
    if (isset($playground['kind']) || isset($playground['view'])) {
        $target = array_intersect_key($playground, array_flip(['kind', 'component', 'view', 'element', 'folder', 'clientId']));
        $target['kind'] ??= 'record';
        $target = playgroundDataCanonicalTarget($target, $application);
        $context = playgroundDataContext($target, [], $application, $database, $administrator);
        $form = $context['model']->getForm($target['kind'] === 'component' ? ($context['data']['params'] ?? []) : $context['data'], false);
        if (!$form) throw new RuntimeException('The native configuration form is unavailable.');
        $form->bind($target['kind'] === 'component' ? ($context['data']['params'] ?? []) : $context['data']);
        $schema = playgroundDataSchema($form, $context['metadata'], $target['kind'] === 'component');
        ob_clean();
        playgroundFinish(['ok' => true, 'schema' => $schema, 'configurationTargets' => [$target + ['schema' => $schema]]]);
        return;
    }
    $components = $database->setQuery("SELECT element, name FROM #__extensions WHERE type = 'component' AND enabled = 1 ORDER BY element")->loadAssocList();
    $menuTypes = [];
    $configurationTargets = [];
    foreach ($components as $component) {
        $element = $component['element'];
        if (!preg_match('/^com_[a-z0-9_]+$/', $element)) continue;
        $application->getLanguage()->load($element . '.sys', JPATH_ADMINISTRATOR);
        $application->getLanguage()->load($element, JPATH_SITE);
        $adminPath = $root . '/administrator/components/' . $element;
        if (is_file($adminPath . '/config.xml')) {
            $configurationTargets[] = ['kind' => 'component', 'component' => $element, 'title' => \Joomla\CMS\Language\Text::_($component['name']), 'modelAvailable' => true];
        }
        foreach (glob($adminPath . '/forms/*.xml') ?: [] as $formPath) {
            $view = basename($formPath, '.xml');
            if (!preg_match('/^[a-z][a-z0-9_]*$/', $view) || in_array($view, ['server', 'servers'], true) && $element === 'com_componentbuilder') continue;
            if (!is_file($adminPath . '/src/Model/' . ucfirst($view) . 'Model.php') && !is_file($adminPath . '/models/' . $view . '.php')) continue;
            $configurationTargets[] = ['kind' => 'record', 'component' => $element, 'view' => $view,
                'title' => \Joomla\CMS\Language\Text::_($component['name']) . ': ' . ucwords(str_replace('_', ' ', $view)), 'modelAvailable' => true];
        }
        $paths = array_merge(glob($root . '/components/' . $element . '/tmpl/*/*.xml') ?: [], glob($root . '/components/' . $element . '/views/*/tmpl/*.xml') ?: []);
        foreach (array_slice($paths, 0, 100) as $path) {
            $xml = simplexml_load_file($path, \SimpleXMLElement::class, LIBXML_NONET);
            if (!$xml || !isset($xml->layout)) continue;
            $parts = explode('/', str_replace($root . '/components/' . $element . '/', '', $path));
            $view = $parts[1];
            $fields = [];
            foreach ($xml->xpath('//fields/fieldset/field') ?: [] as $field) {
                $parents = $field->xpath('ancestor::fields[1]');
                $group = (string) ($parents[0]['name'] ?? 'request');
                $options = [];
                foreach ($field->option as $option) $options[] = ['value' => (string) $option['value'], 'title' => \Joomla\CMS\Language\Text::_((string) $option)];
                $fields[] = ['name' => (string) $field['name'], 'type' => (string) $field['type'],
                    'group' => $group === 'request' ? 'query' : $group, 'options' => $options,
                    'default' => (string) $field['default'], 'description' => strip_tags(\Joomla\CMS\Language\Text::_((string) $field['description'])),
                    'label' => \Joomla\CMS\Language\Text::_((string) $field['label']), 'required' => (string) $field['required'] === 'true'];
            }
            $menuTypes[] = ['component' => $element, 'view' => $view, 'layout' => basename($path, '.xml'),
                'title' => \Joomla\CMS\Language\Text::_((string) $xml->layout['title']), 'fields' => $fields];
        }
    }
    $templates = $database->setQuery('SELECT id, template, title, home FROM #__template_styles WHERE client_id = 0 ORDER BY title, id')->loadAssocList();
    foreach ($templates as &$template) {
        if (!preg_match('/^[a-z0-9_]+$/', $template['template'])) continue;
        $path = $root . '/templates/' . $template['template'] . '/templateDetails.xml';
        if (!is_file($path)) continue;
        try {
            $xml = simplexml_load_file($path, \SimpleXMLElement::class, LIBXML_NONET);
            if ($xml && isset($xml->config)) {
                $application->getLanguage()->load('tpl_' . $template['template'], JPATH_SITE);
                $application->getLanguage()->load('tpl_' . $template['template'], dirname($path));
                $form = \Joomla\CMS\Form\Form::getInstance('playground.template.' . $template['id'], (string) $xml->config->asXML(), ['control' => 'jform']);
                $template['schema'] = playgroundDataSchema($form, null, true);
            }
        } catch (Throwable $error) {
            // Custom template field types may require their own model. Other targets remain usable.
        }
    }
    unset($template);
    foreach ($database->setQuery("SELECT type, element, folder, client_id, name FROM #__extensions WHERE type IN ('plugin', 'module') ORDER BY type, folder, element")->loadAssocList() as $extension) {
        // Match Joomla's own extension lists: these labels live in .sys language
        // files, which are not loaded by creating the administrator application.
        if ($extension['type'] === 'module') {
            $clientPath = (int) $extension['client_id'] === 1 ? JPATH_ADMINISTRATOR : JPATH_SITE;
            $languageExtension = $extension['element'] . '.sys';
            $application->getLanguage()->load($languageExtension, $clientPath)
                || $application->getLanguage()->load($languageExtension, $clientPath . '/modules/' . $extension['element']);
        } else {
            $languageExtension = 'plg_' . $extension['folder'] . '_' . $extension['element'] . '.sys';
            $application->getLanguage()->load($languageExtension, JPATH_ADMINISTRATOR)
                || $application->getLanguage()->load($languageExtension, JPATH_PLUGINS . '/' . $extension['folder'] . '/' . $extension['element']);
        }
        $target = ['kind' => $extension['type'], 'element' => $extension['element'], 'title' => \Joomla\CMS\Language\Text::_($extension['name']), 'modelAvailable' => true];
        if ($extension['type'] === 'plugin') $target['folder'] = $extension['folder'];
        else $target['clientId'] = (int) $extension['client_id'];
        $configurationTargets[] = $target;
    }
    $menus = $database->setQuery('SELECT id, title, alias, menutype, language, home, link FROM #__menu WHERE client_id = 0 AND id > 1 ORDER BY menutype, lft')->loadAssocList();
    ob_clean();
    playgroundFinish(['ok' => true, 'menuTypes' => $menuTypes, 'templates' => $templates, 'menus' => $menus, 'configurationTargets' => $configurationTargets]);
} catch (Throwable $error) {
    ob_clean();
    playgroundFinish(['ok' => false, 'error' => playgroundDataRedact($error->getMessage(), $playground)]);
}
