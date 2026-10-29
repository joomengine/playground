<?php
try {
    $root = playgroundRoot($playground);
    $marker = null;
    $markerError = null;
    if (is_file($playground['marker'])) {
        try { $marker = json_decode(file_get_contents($playground['marker']), true, 512, JSON_THROW_ON_ERROR); }
        catch (Throwable $error) {
            if (empty($playground['recovery'])) throw $error;
            $markerError = $error->getMessage();
        }
    }
    playgroundFinish([
        'ok' => true,
        'configured' => is_file($root . '/configuration.php'),
        'installerPresent' => is_dir($root . '/installation'),
        'marker' => $marker,
        'markerError' => $markerError,
    ]);
} catch (Throwable $error) {
    playgroundFinish(['ok' => false, 'error' => $error->getMessage()]);
}
