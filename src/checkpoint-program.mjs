function parameter(value) {
  if (typeof value !== 'string' || !/^\/tmp\/rocket-checkpoint-[a-z0-9-]+\.zip$/.test(value)) {
    throw new TypeError('Use an internal checkpoint archive path.');
  }
  return JSON.stringify(value);
}

/** Private checkpoints preserve sessions and metadata; they are never deployment exports. */
export function checkpointSource(destination) {
  return `<?php
$target = ${parameter(destination)};
$zip = new ZipArchive();
if ($zip->open($target, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) throw new RuntimeException('Cannot create the private runtime checkpoint.');
$entries = []; $total = 0;
foreach (['persist', 'config'] as $root) {
    $base = '/' . $root;
    $zip->addEmptyDir($root);
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
    foreach ($iterator as $entry) {
        if (count($entries) >= 100000 || $entry->isLink()) throw new RuntimeException('The checkpoint contains too many entries or an unsupported symbolic link.');
        $name = $root . '/' . substr($entry->getPathname(), strlen($base) + 1);
        if ($entry->isDir()) {
            if (!$zip->addEmptyDir($name)) throw new RuntimeException('Cannot checkpoint directory ' . $name);
            $entries[] = ['path' => $name, 'directory' => true, 'mode' => $entry->getPerms() & 0777];
        } elseif ($entry->isFile()) {
            $size = $entry->getSize(); $total += $size;
            if ($total > 1073741824 || !$zip->addFile($entry->getPathname(), $name)) throw new RuntimeException('The private checkpoint exceeds its size limit or a file could not be read.');
            $entries[] = ['path' => $name, 'directory' => false, 'size' => $size, 'sha256' => hash_file('sha256', $entry->getPathname()), 'mode' => $entry->getPerms() & 0777, 'mtime' => $entry->getMTime()];
        } else throw new RuntimeException('The checkpoint contains an unsupported filesystem entry.');
    }
}
$zip->addFromString('checkpoint.json', json_encode(['format' => 'joomengine-private-checkpoint', 'version' => 1, 'entries' => $entries], JSON_THROW_ON_ERROR));
if (!$zip->close()) throw new RuntimeException('The private checkpoint could not be completed.');
clearstatcache(true, $target);
if (filesize($target) > 536870912) { unlink($target); throw new RuntimeException('The compressed checkpoint exceeds 512 MiB.'); }
header('Content-Type: application/json');
echo json_encode(['ok' => true, 'size' => filesize($target), 'sha256' => hash_file('sha256', $target)], JSON_THROW_ON_ERROR);
`;
}

export function restoreCheckpointSource(archivePath) {
  return `<?php
$archive = ${parameter(archivePath)};
$zip = new ZipArchive();
if ($zip->open($archive, ZipArchive::CHECKCONS) !== true) throw new RuntimeException('The private checkpoint is not a valid ZIP.');
$raw = $zip->getFromName('checkpoint.json');
if ($raw === false || strlen($raw) > 33554432) throw new RuntimeException('The private checkpoint manifest is missing or oversized.');
$manifest = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
if (($manifest['format'] ?? '') !== 'joomengine-private-checkpoint' || ($manifest['version'] ?? 0) !== 1 || !is_array($manifest['entries'] ?? null) || count($manifest['entries']) > 100000) throw new RuntimeException('The private checkpoint format is unsupported.');
$seen = []; $total = 0;
foreach ($manifest['entries'] as $entry) {
    $name = $entry['path'] ?? '';
    if (!is_string($name) || !preg_match('~^(persist|config)/[^\\\\\\x00]+$~D', $name) || array_intersect(explode('/', $name), ['', '.', '..']) || isset($seen[$name])) throw new RuntimeException('The private checkpoint contains an unsafe or duplicate path.');
    $seen[$name] = true;
    $directory = ($entry['directory'] ?? null) === true;
    $stat = $zip->statName($name . ($directory ? '/' : ''));
    if ($stat === false) throw new RuntimeException('The private checkpoint is incomplete.');
    if (!$directory) {
        $size = $entry['size'] ?? -1; $total += $size;
        if (!is_int($size) || $size < 0 || $size !== $stat['size'] || $total > 1073741824 || !preg_match('/^[a-f0-9]{64}$/D', $entry['sha256'] ?? '')) throw new RuntimeException('The private checkpoint has invalid file sizes or checksums.');
        $stream = $zip->getStream($name);
        if ($stream === false) throw new RuntimeException('Cannot read a checkpoint file.');
        $hash = hash_init('sha256'); hash_update_stream($hash, $stream); fclose($stream);
        if (!hash_equals($entry['sha256'], hash_final($hash))) throw new RuntimeException('A private checkpoint file failed its integrity check.');
    }
}
$remove = function ($path) use (&$remove) {
    if (is_dir($path) && !is_link($path)) {
        foreach (scandir($path) as $name) if ($name !== '.' && $name !== '..') $remove($path . '/' . $name);
        if (!rmdir($path)) throw new RuntimeException('Cannot clear a runtime checkpoint destination.');
    } elseif (!unlink($path)) throw new RuntimeException('Cannot clear a runtime checkpoint file.');
};
foreach (['/persist', '/config'] as $root) foreach (scandir($root) as $name) if ($name !== '.' && $name !== '..') $remove($root . '/' . $name);
foreach ($manifest['entries'] as $entry) {
    $target = '/' . $entry['path'];
    if ($entry['directory']) {
        if (!is_dir($target) && !mkdir($target, 0755, true)) throw new RuntimeException('Cannot restore a checkpoint directory.');
    } else {
        if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0755, true)) throw new RuntimeException('Cannot restore a checkpoint parent directory.');
        $from = $zip->getStream($entry['path']); $to = fopen($target, 'wb');
        if ($from === false || $to === false) throw new RuntimeException('Cannot restore a checkpoint file.');
        $copied = stream_copy_to_stream($from, $to); fclose($from); fclose($to);
        if ($copied !== $entry['size']) throw new RuntimeException('A restored checkpoint file is incomplete.');
        if (isset($entry['mtime'])) touch($target, (int) $entry['mtime']);
    }
    chmod($target, ((int) ($entry['mode'] ?? 0644)) & 0777);
}
$zip->close();
header('Content-Type: application/json'); echo json_encode(['ok' => true, 'entries' => count($manifest['entries']), 'restoredCookies' => is_file('/config/.cookies') ? file_get_contents('/config/.cookies') : null], JSON_THROW_ON_ERROR);
`;
}
