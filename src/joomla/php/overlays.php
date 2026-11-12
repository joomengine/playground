<?php
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $administrator = playgroundDataAdministrator($root, $playground, $application, $container, $database);
    $bindings = playgroundDataBindings($root);
    $available = [];
    foreach ($bindings as $key => $binding) $available[$key] = $binding + ['key' => $key, 'status' => 'applied'];
    $pending = [];
    foreach ($playground['overlays'] ?? [] as $entry) {
        $key = playgroundDataIdentifier($entry['key'] ?? null, 'overlay key', '/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/');
        if (isset($pending[$key])) throw new InvalidArgumentException('Deployment overlay keys must be unique.');
        $pending[$key] = $entry;
        // A pending update must complete before another entry can use its previous result.
        unset($available[$key]);
    }
    $results = [];
    $warnings = [];
    while ($pending) {
        $progress = false;
        foreach ($pending as $key => $entry) {
            $dependencies = array_unique(array_merge($entry['dependsOn'] ?? [], playgroundDataDependencies($entry['fields'] ?? []), playgroundDataDependencies($entry['source'] ?? [])));
            if (array_intersect($dependencies, array_keys($pending))) continue;
            $progress = true;
            unset($pending[$key]);
            ob_start();
            try {
                foreach ($dependencies as $dependency) if (($available[$dependency]['status'] ?? null) !== 'applied') throw new RuntimeException('Dependency ' . $dependency . ' was not applied.');
                $resolved = $entry;
                $resolved = playgroundDataCanonicalTarget($resolved, $application);
                $resolved['fields'] = playgroundDataReferences($entry['fields'] ?? [], $available);
                if (isset($entry['source'])) $resolved['source'] = playgroundDataReferences($entry['source'], $available);
                $identity = playgroundDataApply($resolved, $bindings, $application, $database, $administrator);
                $bindings[$key] = ['target' => playgroundDataTarget($resolved)] + $identity;
                playgroundDataSaveBindings($root, $bindings);
                $result = ['key' => $key, 'status' => 'applied'] + $identity;
            } catch (Throwable $error) {
                $notice = playgroundDataRedact('Configuration ' . $key . ' was skipped: ' . $error->getMessage(), $playground);
                $warnings[] = $notice;
                $result = ['key' => $key, 'status' => 'skipped', 'notice' => $notice];
            } finally {
                ob_end_clean();
            }
            $available[$key] = $result;
            $results[] = $result;
        }
        if (!$progress) {
            foreach ($pending as $key => $entry) {
                $notice = 'Configuration ' . $key . ' was skipped because its dependencies are cyclic.';
                $warnings[] = $notice;
                $results[] = ['key' => $key, 'status' => 'skipped', 'notice' => $notice];
            }
            break;
        }
    }
    ob_clean();
    playgroundFinish(['ok' => true, 'results' => $results, 'warnings' => $warnings, 'overlayWarnings' => $warnings]);
} catch (Throwable $error) {
    ob_clean();
    playgroundFinish(['ok' => false, 'error' => playgroundDataRedact($error->getMessage(), $playground)]);
}
