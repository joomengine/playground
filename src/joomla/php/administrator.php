<?php
try {
    $root = playgroundRoot($playground);
    $directory = dirname($root) . '/meta';
    $path = $directory . '/administrator.json';
    $mode = $playground['mode'] ?? 'read';
    if (!in_array($mode, ['read', 'write', 'replace'], true)) {
        throw new InvalidArgumentException('Unknown administrator metadata operation.');
    }
    $administrator = null;
    if ($mode === 'read') {
        if (is_file($path)) {
            $metadata = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            if (($metadata['schemaVersion'] ?? null) !== 1) {
                throw new RuntimeException('Unsupported saved administrator metadata.');
            }
            $administrator = $metadata['administrator'] ?? null;
        }
    } else {
        $administrator = $playground['admin'] ?? null;
    }
    if ($administrator !== null) {
        foreach (['name', 'username', 'email', 'password'] as $field) {
            if (!isset($administrator[$field]) || !is_string($administrator[$field]) || $administrator[$field] === '' || str_contains($administrator[$field], "\0")) {
                throw new RuntimeException('Saved administrator metadata is incomplete.');
            }
        }
    }
    if ($mode === 'replace') {
        [$application, $container, $database] = playgroundApplication($root);
        $ids = $database->setQuery('SELECT id FROM #__users WHERE block = 0 ORDER BY id')->loadColumn();
        $factory = $container->get(\Joomla\CMS\User\UserFactoryInterface::class);
        $user = null;
        foreach ($ids as $id) {
            $candidate = $factory->loadUserById((int) $id);
            if ($candidate->authorise('core.admin')) {
                $user = $candidate;
                break;
            }
        }
        if ($user === null) {
            throw new RuntimeException('The restored site has no active Super User account.');
        }
        $application->loadIdentity($user);
        $values = [
            'name' => $administrator['name'], 'username' => $administrator['username'],
            'email' => $administrator['email'], 'password' => $administrator['password'],
            'password2' => $administrator['password'], 'block' => 0, 'requireReset' => 0,
        ];
        if (!$user->bind($values) || !$user->save()) {
            throw new RuntimeException('Cannot configure the restored site administrator: ' . $user->getError());
        }
    }
    if ($mode !== 'read') {
        if (!is_dir($directory) && !mkdir($directory, 0700, true)) {
            throw new RuntimeException('Cannot create private site metadata storage.');
        }
        $data = json_encode(['schemaVersion' => 1, 'administrator' => $administrator], JSON_THROW_ON_ERROR);
        if (file_put_contents($path, $data) !== strlen($data)) {
            throw new RuntimeException('Cannot save the site administrator metadata.');
        }
        chmod($path, 0600);
    }
    playgroundFinish(['ok' => true, 'administrator' => $administrator]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
