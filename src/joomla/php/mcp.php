<?php
/** Configure the installed HTTP endpoint using Joomla's own token plugin. */
try {
    $root = playgroundRoot($playground);
    [$application, $container, $database] = playgroundApplication($root, true);
    $extension = new \Joomla\CMS\Table\Extension($database);
    if (!$extension->load(['type' => 'component', 'element' => 'com_joomengine_mcp']) || (int) $extension->enabled !== 1) {
        playgroundFinish(['ok' => true, 'installed' => false]);
        return;
    }
    $credentials = $playground['admin'] ?? [];
    if (!is_string($credentials['username'] ?? null) || !is_string($credentials['password'] ?? null)
        || $credentials['username'] === '' || $credentials['password'] === '') {
        throw new RuntimeException('Administrator credentials are required to connect to MCP.');
    }
    if ($application->login(['username' => $credentials['username'], 'password' => $credentials['password']], ['silent' => true]) !== true) {
        throw new RuntimeException('Administrator authentication failed for MCP.');
    }
    $user = $application->getIdentity();
    if (!$user || (int) $user->id < 1 || (int) $user->guest !== 0 || (int) $user->block !== 0
        || (int) $user->requireReset !== 0 || !$user->authorise('core.login.api')
        || !$user->authorise('core.manage', 'com_joomengine_mcp') || !$user->authorise('mcp.access', 'com_joomengine_mcp')) {
        throw new RuntimeException('This administrator cannot connect to the MCP API.');
    }
    $userOptions = \Joomla\CMS\Component\ComponentHelper::getParams('com_users');
    if (\Joomla\Component\Users\Administrator\Helper\Mfa::getUserMfaRecords($user->id)
        || array_intersect((array) $userOptions->get('forceMFAUserGroups', []), $user->getAuthorisedGroups())
        || $application->getSession()->get('com_users.mandatory_mfa_setup', 0)) {
        throw new RuntimeException('Complete interactive multi-factor authentication before connecting this administrator to MCP.');
    }
    if (($playground['initialize'] ?? false) === true) {
        foreach (['user', 'api-authentication'] as $folder) {
            $plugin = new \Joomla\CMS\Table\Extension($database);
            if (!$plugin->load(['type' => 'plugin', 'folder' => $folder, 'element' => 'token'])) {
                throw new RuntimeException('The Joomla API token plugins are required.');
            }
            $plugin->enabled = 1;
            if (!$plugin->store()) throw new RuntimeException('Cannot enable the Joomla API token plugin.');
        }
        \Joomla\CMS\Plugin\PluginHelper::importPlugin('user');
        // A fresh deployment receives a fresh native Joomla token, including restored public snapshots.
        $user->set('joomlatoken', ['enabled' => 1, 'reset' => 1]);
        if (!$user->save()) throw new RuntimeException('Cannot configure the administrator API token.');
    }
    if (!\Joomla\CMS\Plugin\PluginHelper::isEnabled('user', 'token')
        || !\Joomla\CMS\Plugin\PluginHelper::isEnabled('api-authentication', 'token')) {
        throw new RuntimeException('Enable Joomla API token authentication before connecting MCP.');
    }
    $apiBase = $playground['apiBase'] ?? '';
    $parts = is_string($apiBase) ? parse_url($apiBase) : false;
    $loopback = $parts !== false && in_array($parts['host'] ?? '', ['localhost', '127.0.0.1', '[::1]'], true);
    if ($parts === false || !isset($parts['host']) || isset($parts['user']) || isset($parts['pass'])
        || isset($parts['query']) || isset($parts['fragment']) || !str_ends_with($parts['path'] ?? '', '/api/index.php')
        || !(($parts['scheme'] ?? '') === 'https' || (($parts['scheme'] ?? '') === 'http' && $loopback))) {
        throw new InvalidArgumentException('The MCP API URL must target this HTTPS site.');
    }
    $params = new \Joomla\Registry\Registry($extension->params);
    $params->set('api_base', $apiBase);
    $params->set('allow_loopback_http', ($parts['scheme'] ?? '') === 'http' && $loopback);
    $extension->params = (string) $params;
    if (!$extension->store()) throw new RuntimeException('Cannot configure the MCP endpoint.');
    $profile = (object) ['id' => (int) $user->id];
    $application->getInput()->set('layout', 'default');
    $application->bootPlugin('token', 'user')->onContentPrepareData(
        new \Joomla\CMS\Event\Model\PrepareDataEvent('onContentPrepareData', ['context' => 'com_users.profile', 'data' => $profile])
    );
    $token = $profile->joomlatoken['token'] ?? '';
    if (!is_string($token) || $token === '') throw new RuntimeException('This administrator has no enabled Joomla API token.');
    $manifest = json_decode($extension->manifest_cache, true, 32, JSON_THROW_ON_ERROR);
    // This private response is only returned to the owning runtime, never deployment URLs or activity logs.
    playgroundFinish(['ok' => true, 'installed' => true, 'version' => $manifest['version'] ?? null,
        'endpoint' => $apiBase . '/v1/joomengine-mcp', 'token' => $token]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
