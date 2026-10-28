<?php
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $components = $database->setQuery("SELECT element, name FROM #__extensions WHERE type = 'component' AND enabled = 1 ORDER BY element")->loadAssocList();
    $menuTypes = [];
    foreach ($components as $component) {
        $element = $component['element'];
        if (!preg_match('/^com_[a-z0-9_]+$/', $element)) continue;
        $application->getLanguage()->load($element . '.sys', JPATH_ADMINISTRATOR);
        $application->getLanguage()->load($element, JPATH_SITE);
        $paths = array_merge(glob($root . '/components/' . $element . '/tmpl/*/*.xml') ?: [], glob($root . '/components/' . $element . '/views/*/tmpl/*.xml') ?: []);
        foreach (array_slice($paths, 0, 100) as $path) {
            $xml = simplexml_load_file($path, \SimpleXMLElement::class, LIBXML_NONET);
            if (!$xml || !isset($xml->layout)) continue;
            $parts = explode('/', str_replace($root . '/components/' . $element . '/', '', $path));
            $view = $parts[1];
            $fields = [];
            foreach ($xml->xpath('//fields/fieldset/field') ?: [] as $field) {
                $fields[] = ['name' => (string) $field['name'], 'type' => (string) $field['type'],
                    'label' => \Joomla\CMS\Language\Text::_((string) $field['label']), 'required' => (string) $field['required'] === 'true'];
            }
            $menuTypes[] = ['component' => $element, 'view' => $view, 'layout' => basename($path, '.xml'),
                'title' => \Joomla\CMS\Language\Text::_((string) $xml->layout['title']), 'fields' => $fields];
        }
    }
    $templates = $database->setQuery('SELECT id, template, title, home FROM #__template_styles WHERE client_id = 0 ORDER BY title, id')->loadAssocList();
    $menus = $database->setQuery('SELECT id, title, alias, menutype, language, home, link FROM #__menu WHERE client_id = 0 AND id > 1 ORDER BY menutype, lft')->loadAssocList();
    playgroundFinish(['ok' => true, 'menuTypes' => $menuTypes, 'templates' => $templates, 'menus' => $menus]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
