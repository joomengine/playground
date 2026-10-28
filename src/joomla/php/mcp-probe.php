<?php
/**
 * Private deployment diagnostic for the installed MCP native read primitives.
 * This is not an HTTP/stdio MCP transport and never changes the component's
 * console boundary, API credentials, catalogue or native-process policy.
 */
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $extension = $database->setQuery("SELECT enabled, manifest_cache FROM #__extensions WHERE type = 'component' AND element = 'com_joomengine_mcp'")->loadAssoc();
    if (!$extension || (int) $extension['enabled'] !== 1) {
        playgroundFinish(['ok' => true, 'installed' => false]);
        return;
    }
    $credentials = $playground['admin'] ?? [];
    if (!is_string($credentials['username'] ?? null) || !is_string($credentials['password'] ?? null)
        || $credentials['username'] === '' || $credentials['password'] === '') {
        throw new RuntimeException('Administrator credentials are required for the MCP native read diagnostic.');
    }
    if ($application->login(['username' => $credentials['username'], 'password' => $credentials['password']], ['silent' => true]) !== true) {
        throw new RuntimeException('Administrator authentication failed for the MCP native read diagnostic.');
    }
    $user = $application->getIdentity();
    if (!$user || (int) $user->id < 1 || (int) $user->guest !== 0 || (int) $user->block !== 0
        || (int) $user->requireReset !== 0 || !$user->authorise('core.login.admin')) {
        throw new RuntimeException('An active Joomla administrator is required for the MCP native read diagnostic.');
    }
    $userOptions = \Joomla\CMS\Component\ComponentHelper::getParams('com_users');
    $requiredGroups = (array) $userOptions->get('forceMFAUserGroups', []);
    if (\Joomla\Component\Users\Administrator\Helper\Mfa::getUserMfaRecords($user->id)
        || array_intersect($requiredGroups, $user->getAuthorisedGroups())
        || $application->getSession()->get('com_users.mandatory_mfa_setup', 0)) {
        throw new RuntimeException('Complete interactive multi-factor authentication before running MCP diagnostics for this administrator.');
    }
    foreach (['core.manage', 'mcp.access', 'mcp.execute'] as $permission) {
        if (!$user->authorise($permission, 'com_joomengine_mcp')) {
            throw new RuntimeException('This administrator cannot run the MCP native read diagnostic.');
        }
    }
    if (!extension_loaded('sodium') || !function_exists('sodium_crypto_aead_xchacha20poly1305_ietf_encrypt')) {
        throw new RuntimeException('The installed MCP component requires the Sodium PHP extension.');
    }
    $application->bootComponent('com_joomengine_mcp');
    $factory = new \VDM\Component\JoomEngineMcp\Administrator\Handler\NativeFactory(
        new \VDM\Component\JoomEngineMcp\Administrator\Native\Joomla\JoomlaModelProvider($application),
        new \VDM\Component\JoomEngineMcp\Administrator\Native\Joomla\JoomlaNativeOperations($application),
        $application
    );
    $results = [];
    // The caller cannot choose handlers, models, arguments, commands or writes.
    $reads = [
        'systemInfo' => ['name' => 'system.info', 'handler' => 'native.system-info', 'configuration' => [], 'input' => []],
        'extensions' => ['name' => 'extensions.installed.list', 'handler' => 'native.list-extensions',
            'configuration' => ['actionName' => 'extensions.installed.list'], 'input' => ['offset' => 0, 'limit' => 100, 'type' => 'component']],
    ];
    foreach ($reads as $key => $read) {
        $action = $factory->create(['handler' => $read['handler'], 'configuration' => $read['configuration']]);
        $descriptor = $action->descriptor();
        if ($descriptor->name !== $read['name'] || $descriptor->risk !== 'read') {
            throw new RuntimeException('The installed MCP primitive no longer matches the reviewed read contract.');
        }
        foreach ($descriptor->acl as $rule) {
            if (!$user->authorise($rule['action'], $rule['asset'])) {
                throw new RuntimeException('Joomla denied the permissions required by the MCP native read primitive.');
            }
        }
        $results[$key] = $action->execute($read['input']);
    }
    $manifest = json_decode($extension['manifest_cache'], true, 32, JSON_THROW_ON_ERROR);
    playgroundFinish(['ok' => true, 'installed' => true, 'version' => $manifest['version'] ?? null,
        'nativeReads' => $results,
        'capabilities' => ['browserNativeReadProbe' => true, 'externalMcpEndpoint' => false,
            'nativeProcessJobs' => false, 'stdio' => false]]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
