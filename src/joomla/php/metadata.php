<?php
/** Read an extension version from its XML without resolving external entities. */
function playgroundJcbManifest($xml)
{
    $previous = libxml_use_internal_errors(true);
    try {
        $manifest = simplexml_load_string($xml, SimpleXMLElement::class, LIBXML_NONET);
        if (!$manifest || $manifest->getName() !== 'extension') {
            throw new RuntimeException('The JCB package manifest is invalid.');
        }
        return $manifest;
    } finally {
        libxml_clear_errors();
        libxml_use_internal_errors($previous);
    }
}

function playgroundJcbVersion($value)
{
    $value = ltrim(trim((string) $value), 'vV');
    return preg_match('/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/', $value) ? $value : null;
}

/** Check the package's actual component version before Joomla can change files. */
function playgroundJcbArchiveVersion($archive, $depth = 0)
{
    if ($depth > 1) {
        throw new RuntimeException('The selected JCB package contains an unsupported nested package.');
    }
    $zip = new ZipArchive();
    if ($zip->open($archive) !== true) {
        throw new RuntimeException('The selected JCB ZIP could not be opened.');
    }
    try {
        for ($index = 0; $index < $zip->numFiles; $index++) {
            $name = $zip->getNameIndex($index);
            if (!in_array(strtolower(basename($name)), ['componentbuilder.xml', 'pkg_component_builder.xml'], true)) {
                continue;
            }
            $manifest = playgroundJcbManifest($zip->getFromIndex($index));
            if ((string) $manifest['type'] === 'component' && strtolower(basename($name)) === 'componentbuilder.xml') {
                $version = playgroundJcbVersion($manifest->version);
                if ($version) {
                    return $version;
                }
            }
            if ((string) $manifest['type'] !== 'package') {
                continue;
            }
            foreach ($manifest->files->file ?? [] as $file) {
                if ((string) $file['type'] !== 'component' || (string) $file['id'] !== 'com_componentbuilder') {
                    continue;
                }
                $nestedName = ltrim((string) $file, '/');
                $folder = trim((string) $manifest->files['folder'], '/');
                $directory = dirname($name);
                $nested = $zip->getFromName(($directory !== '.' ? $directory . '/' : '') . ($folder !== '' ? $folder . '/' : '') . $nestedName);
                if ($nested === false) {
                    throw new RuntimeException('The selected package is missing its JCB component ZIP.');
                }
                $temporary = tempnam('/tmp', 'joomengine-jcb-');
                if ($temporary === false || file_put_contents($temporary, $nested) !== strlen($nested)) {
                    throw new RuntimeException('The JCB component ZIP could not be inspected.');
                }
                try {
                    return playgroundJcbArchiveVersion($temporary, $depth + 1);
                } finally {
                    if (is_file($temporary)) {
                        unlink($temporary);
                    }
                }
            }
        }
        throw new RuntimeException('The selected ZIP does not contain a verified Joomla Component Builder manifest.');
    } finally {
        $zip->close();
    }
}

try {
    $root = playgroundRoot($playground);
    if (!is_file($root . '/configuration.php')) {
        throw new RuntimeException('Joomla configuration is missing.');
    }
    require $root . '/configuration.php';
    $configuration = new JConfig();
    $connection = new PDO('mysql:dbname=' . $configuration->db . ';charset=utf8mb4', $configuration->user, $configuration->password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $prefix = $configuration->dbprefix;
    if (!preg_match('/^[a-zA-Z0-9_]+$/', $prefix)) {
        throw new RuntimeException('The Joomla table prefix is invalid.');
    }
    $languageSettings = $connection->query('SELECT params FROM `' . $prefix . 'extensions` WHERE type = \'component\' AND element = \'com_languages\'')->fetchColumn();
    $languageSettings = json_decode($languageSettings ?: '{}', true, 512, JSON_THROW_ON_ERROR);
    $jcb = $connection->query('SELECT manifest_cache FROM `' . $prefix . 'extensions` WHERE type = \'component\' AND element = \'com_componentbuilder\'')->fetch(PDO::FETCH_ASSOC);
    $connection = null;
    $jcbManifestPath = $root . '/administrator/components/com_componentbuilder/componentbuilder.xml';
    $jcbInstalled = $jcb !== false || is_file($jcbManifestPath);
    $jcbVersion = $jcbInstalled ? null : 'none';
    if (is_file($jcbManifestPath)) {
        try {
            $jcbVersion = playgroundJcbVersion(playgroundJcbManifest(file_get_contents($jcbManifestPath))->version);
        } catch (Throwable $error) {
            // Keep an unknown installation distinct from an absent component.
        }
    } elseif ($jcb !== false) {
        $cached = json_decode($jcb['manifest_cache'] ?: '{}', true);
        $jcbVersion = playgroundJcbVersion($cached['version'] ?? '');
    }
    $manifest = simplexml_load_file($root . '/administrator/manifests/files/joomla.xml', SimpleXMLElement::class, LIBXML_NONET);
    if (!$manifest) {
        throw new RuntimeException('Joomla version manifest is missing.');
    }
    $result = ['ok' => true, 'version' => (string) $manifest->version, 'siteName' => $configuration->sitename,
        'language' => $languageSettings['site'] ?? 'en-GB', 'jcbInstalled' => $jcbInstalled, 'jcbVersion' => $jcbVersion];
    if (isset($playground['jcbTargetVersion'])) {
        $target = playgroundJcbVersion($playground['jcbTargetVersion']);
        if (!$target || ($jcbInstalled && !$jcbVersion)) {
            throw new RuntimeException('The installed or requested JCB version could not be verified.');
        }
        $result['jcbComparison'] = $jcbInstalled ? version_compare($target, $jcbVersion) : 1;
        if (isset($playground['jcbArchive'])) {
            $archive = $playground['jcbArchive'];
            if (!is_string($archive) || !preg_match('~^/tmp/joomengine-jcb-upgrade-[a-f0-9-]+\.zip$~', $archive)) {
                throw new RuntimeException('The JCB upgrade archive path is invalid.');
            }
            $candidate = playgroundJcbArchiveVersion($archive);
            if (version_compare($candidate, $target) !== 0) {
                throw new RuntimeException('The selected ZIP contains JCB ' . $candidate . ', not the requested ' . $target . '.');
            }
            if ($jcbInstalled && version_compare($candidate, $jcbVersion) < 0) {
                throw new RuntimeException('The selected ZIP would downgrade the installed JCB component.');
            }
            $result['candidateJcbVersion'] = $candidate;
        }
    }
    playgroundFinish($result);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
