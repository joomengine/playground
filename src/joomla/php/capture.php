<?php
/** Capture persisted values through native models, with explicit portable relationships. */
function playgroundCaptureRecord(array $target, int $id, $application, $database, $administrator, array &$related, array &$warnings, array &$seen, int $depth = 0): array
{
    $context = playgroundDataContext($target, [], $application, $database, $administrator, $id);
    extract($context);
    $key = $target['key'] ?? strtolower(($kind === 'record' ? $target['component'] . '-' . $target['view'] : $kind . '-' . ($target['element'] ?? $target['component'])) . '-' . ($data['guid'] ?? $id));
    playgroundDataIdentifier($key, 'captured overlay key', '/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/');
    $identity = playgroundDataTarget($target) . ':' . $id;
    $seen[$identity] = $key;
    $overlay = ['key' => $key, 'kind' => $kind];
    foreach (['component', 'view', 'element', 'folder', 'clientId'] as $name) if (isset($target[$name])) $overlay[$name] = $target[$name];
    if ($kind === 'record' && !empty($data['guid'])) $overlay['guid'] = $data['guid'];
    if ($kind === 'component') $fields = ['params' => $data['params']];
    elseif ($kind === 'plugin') $fields = array_intersect_key($data, array_flip(['params', 'enabled', 'ordering', 'access']));
    else $fields = playgroundDataPortableFields(array_intersect_key($data, $table->getFields()));
    if ($kind === 'module') {
        unset($fields['module'], $fields['client_id']);
        // Menu IDs from another site are not portable. Preserve only the all/no-pages choices.
        if (isset($data['assignment']) && in_array((int) $data['assignment'], [0], true)) $fields['assignment'] = (int) $data['assignment'];
        elseif (!empty($data['assigned'])) $warnings[] = 'Module menu assignments use site-specific IDs and were omitted.';
    }
    foreach ($metadata ?? [] as $name => $definition) {
        if (!isset($fields[$name]) || empty($fields[$name]) || empty($definition['link'])) continue;
        $link = $definition['link'];
        $referenceField = $link['key'] ?? '';
        if (!in_array($referenceField, ['id', 'guid'], true)) continue;
        if ($referenceField === 'id' && !is_numeric($fields[$name])) continue;
        if (empty($link['component']) || empty($link['entity']) || $depth >= 3) {
            unset($fields[$name]);
            $warnings[] = 'The site-specific relationship ' . $name . ' was omitted because its target could not be captured safely.';
            continue;
        }
        $nextTarget = ['kind' => 'record', 'component' => $link['component'], 'view' => $link['entity']];
        $nextId = $referenceField === 'id' ? (int) $fields[$name] : 0;
        if ($referenceField === 'guid') {
            try {
                $lookup = playgroundDataContext($nextTarget + ['guid' => $fields[$name]], [], $application, $database, $administrator);
                $nextId = $lookup['id'];
            } catch (Throwable $error) {
                $warnings[] = 'The GUID relationship ' . $name . ' was retained, but its target could not be included.';
                continue;
            }
            if (!$nextId) { $warnings[] = 'The GUID relationship ' . $name . ' was retained, but its target is missing from this site.'; continue; }
        }
        $nextIdentity = playgroundDataTarget($nextTarget) . ':' . $nextId;
        if (isset($seen[$nextIdentity])) {
            if ($referenceField === 'guid') continue;
            // A cycle cannot be inserted in one pass without temporarily invalid native records.
            unset($fields[$name]);
            $warnings[] = 'The cyclic relationship ' . $name . ' was omitted; set it after the related records exist.';
            continue;
        }
        try {
            $captured = playgroundCaptureRecord($nextTarget, $nextId, $application, $database, $administrator, $related, $warnings, $seen, $depth + 1);
            $related[$captured['key']] = $captured;
            $fields[$name] = ['$ref' => $captured['key'], 'field' => $referenceField];
        } catch (Throwable $error) {
            unset($fields[$name]);
            $warnings[] = 'The site-specific relationship ' . $name . ' was omitted because its target does not support capture.';
        }
    }
    // Native forms load from the current component, which a related record may have changed.
    $context = playgroundDataContext($target, [], $application, $database, $administrator, $id);
    $form = $context['model']->getForm($kind === 'component' ? $data['params'] : $data, false);
    if (!$form) throw new RuntimeException('The saved record has no native editable form.');
    $form->bind($kind === 'component' ? $data['params'] : $data);
    if ($kind === 'record') foreach (array_keys($fields) as $name) {
        // Tables can contain infrastructure columns which their native form does
        // not edit (for example an unused JCB params column). Do not export those.
        if (!$form->getField($name) && !$form->getGroup($name, true)) unset($fields[$name]);
    }
    $schema = playgroundDataSchema($form, $metadata, $kind === 'component');
    if (!$metadata && $kind === 'record') {
        // These Joomla fields identify local rows. Without a relationship descriptor their IDs
        // must not be mistaken for identities on a different site.
        foreach ($form->getFieldsets() as $fieldset) foreach ($form->getFieldset($fieldset->name) as $field) {
            if (in_array(strtolower($field->type), ['user', 'category', 'categories', 'modal_article', 'modal_menu', 'menuitem', 'templatestyle'], true) && isset($fields[$field->fieldname]) && !empty($fields[$field->fieldname])) {
                unset($fields[$field->fieldname]);
                $warnings[] = 'The site-specific field ' . $field->fieldname . ' was omitted; choose its destination value in the deployment.';
            }
        }
    }
    $overlay['fields'] = $fields ?: new \stdClass();
    $overlay['schema'] = $schema;
    return $overlay;
}

try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $administrator = playgroundDataAdministrator($root, $playground, $application, $container, $database);
    playgroundDataLanguage($playground, $application, $container);
    $target = array_intersect_key($playground, array_flip(['key', 'kind', 'component', 'view', 'element', 'folder', 'clientId']));
    $target['kind'] ??= 'record';
    $target = playgroundDataCanonicalTarget($target, $application);
    $id = filter_var($playground['id'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
    if ($target['kind'] === 'component' && $id === false) {
        $context = playgroundDataContext($target, [], $application, $database, $administrator);
        $id = $context['id'];
    }
    if ($id === false) throw new InvalidArgumentException('Save the record before cloning it into a deployment.');
    // Administrator navigation identifies extensions/modules by the saved record's ID.
    if ($target['kind'] === 'plugin') {
        $extension = new \Joomla\CMS\Table\Extension($database);
        if (!$extension->load(['extension_id' => $id, 'type' => 'plugin'])) throw new RuntimeException('The saved plugin was not found.');
        $target = ['kind' => 'plugin', 'element' => $extension->element, 'folder' => $extension->folder] + array_intersect_key($target, ['key' => true]);
    } elseif ($target['kind'] === 'module') {
        $module = new \Joomla\CMS\Table\Module($database);
        if (!$module->load($id)) throw new RuntimeException('The saved module was not found.');
        $target = ['kind' => 'module', 'element' => $module->module, 'clientId' => (int) $module->client_id] + array_intersect_key($target, ['key' => true]);
    }
    $related = [];
    $warnings = [];
    $seen = [];
    $overlay = playgroundCaptureRecord($target, $id, $application, $database, $administrator, $related, $warnings, $seen);
    ob_clean();
    playgroundFinish(['ok' => true, 'overlay' => $overlay, 'schema' => $overlay['schema'], 'related' => array_values($related), 'warnings' => array_values(array_unique($warnings))]);
} catch (Throwable $error) {
    ob_clean();
    playgroundFinish(['ok' => false, 'error' => playgroundDataRedact($error->getMessage(), $playground)]);
}
