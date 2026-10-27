<?php
try {
    $root = playgroundRoot($playground);
    $marker = is_file($playground['marker']) ? json_decode(file_get_contents($playground['marker']), true, 512, JSON_THROW_ON_ERROR) : null;
    playgroundFinish([
        'ok' => true,
        'configured' => is_file($root . '/configuration.php'),
        'installerPresent' => is_dir($root . '/installation'),
        'marker' => $marker,
    ]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
