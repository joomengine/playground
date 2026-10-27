<?php
/** Portable Joomla files and SQL exports, produced in one serialized request. */

const PLAYGROUND_EXPORT_LIMIT = 768 * 1024 * 1024;
const PLAYGROUND_DOWNLOAD_LIMIT = 512 * 1024 * 1024;
const PLAYGROUND_EXPORT_FILES = 100000;

function exportFinish(array $result): void
{
    header('Content-Type: application/json; charset=utf-8');
    echo "\n__JOOMENGINE_RESULT__" . json_encode($result, JSON_THROW_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);
}

function exportDirectory(array $options): string
{
    $directory = $options['directory'] ?? '';
    if (!is_string($directory) || !preg_match('/^\/tmp\/joomengine-export-[a-f0-9-]{36}$/D', $directory)) {
        throw new InvalidArgumentException('Invalid export directory.');
    }
    return $directory;
}

function exportRemove(string $directory): void
{
    if (!is_dir($directory)) return;
    foreach (new FilesystemIterator($directory, FilesystemIterator::SKIP_DOTS) as $entry) {
        if ($entry->isDir() && !$entry->isLink()) exportRemove($entry->getPathname());
        elseif (!unlink($entry->getPathname())) throw new RuntimeException('Cannot remove an export temporary file.');
    }
    if (!rmdir($directory)) throw new RuntimeException('Cannot remove the export temporary directory.');
}

function exportIdentifier(string $name): string
{
    if ($name === '' || str_contains($name, "\0")) throw new RuntimeException('The database contains an invalid identifier.');
    return '`' . str_replace('`', '``', $name) . '`';
}

function exportWrite($stream, string $contents, int &$size): void
{
    $length = strlen($contents);
    $size += $length;
    if ($size > PLAYGROUND_EXPORT_LIMIT) throw new RuntimeException('The database export exceeds the 768 MiB limit.');
    $offset = 0;
    while ($offset < $length) {
        $written = fwrite($stream, substr($contents, $offset));
        if ($written === false || $written === 0) throw new RuntimeException('Cannot write the database export.');
        $offset += $written;
    }
}

function exportStatement(array $streams, string $statement, int &$size): void
{
    $statement = rtrim($statement, "; \t\r\n");
    if (strlen($statement) > 4 * 1024 * 1024) throw new RuntimeException('One exported SQL statement exceeds the 4 MiB snapshot import limit.');
    exportWrite($streams['sql'], $statement . ";\n", $size);
    $record = json_encode($statement, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n";
    $recordSize = 0;
    exportWrite($streams['ndjson'], $record, $recordSize);
}

/** Tokenize server-produced DDL without interpreting quoted values as identifiers. */
function exportSqlTokens(string $sql, string $mode = ''): array
{
    $tokens = [];
    $length = strlen($sql);
    $backslash = !in_array('NO_BACKSLASH_ESCAPES', explode(',', $mode), true);
    $ansi = in_array('ANSI_QUOTES', explode(',', $mode), true);
    for ($index = 0; $index < $length;) {
        $start = $index;
        $character = $sql[$index];
        if (ctype_space($character)) {
            while ($index < $length && ctype_space($sql[$index])) ++$index;
            $tokens[] = ['kind' => 'space', 'raw' => substr($sql, $start, $index - $start), 'value' => ''];
        } elseif ($character === '`' || $character === "'" || $character === '"') {
            $quote = $character;
            $identifier = $quote === '`' || ($quote === '"' && $ansi);
            $value = '';
            ++$index;
            $closed = false;
            while ($index < $length) {
                if ($sql[$index] === $quote) {
                    if (($sql[$index + 1] ?? '') === $quote) { $value .= $quote; $index += 2; continue; }
                    ++$index; $closed = true; break;
                }
                if (!$identifier && $backslash && $sql[$index] === '\\') { $value .= substr($sql, $index, 2); $index += 2; continue; }
                $value .= $sql[$index++];
            }
            if (!$closed) throw new RuntimeException('Cannot export unterminated SQL quoting.');
            $tokens[] = ['kind' => $identifier ? 'identifier' : 'string', 'raw' => substr($sql, $start, $index - $start), 'value' => $value];
        } elseif ($character === '#' || ($character === '-' && substr($sql, $index, 2) === '--' && (($sql[$index + 2] ?? ' ') <= ' '))) {
            $end = strpos($sql, "\n", $index);
            $index = $end === false ? $length : $end;
            $tokens[] = ['kind' => 'comment', 'raw' => substr($sql, $start, $index - $start), 'value' => ''];
        } elseif (substr($sql, $index, 2) === '/*') {
            $end = strpos($sql, '*/', $index + 2);
            if ($end === false) throw new RuntimeException('Cannot export an unterminated SQL comment.');
            $index = $end + 2;
            $tokens[] = ['kind' => 'comment', 'raw' => substr($sql, $start, $index - $start), 'value' => ''];
        } elseif (preg_match('/[A-Za-z0-9_$]/', $character)) {
            while ($index < $length && preg_match('/[A-Za-z0-9_$]/', $sql[$index])) ++$index;
            $raw = substr($sql, $start, $index - $start);
            $tokens[] = ['kind' => 'word', 'raw' => $raw, 'value' => $raw];
        } else {
            ++$index;
            $tokens[] = ['kind' => 'symbol', 'raw' => $character, 'value' => $character];
        }
    }
    return $tokens;
}

/** Move DDL ownership/schema to the importing database; data literals stay untouched. */
function exportPortableDdl(string $sql, string $schema, string $kind, string $mode, array $viewNames): array
{
    $tokens = exportSqlTokens($sql, $mode);
    $positions = array_keys(array_filter($tokens, static fn (array $token): bool => !in_array($token['kind'], ['space', 'comment'], true)));
    $objectPosition = null;
    foreach ($positions as $position => $index) {
        if ($tokens[$index]['kind'] === 'word' && strtoupper($tokens[$index]['value']) === $kind) { $objectPosition = $position; break; }
    }
    if ($objectPosition === null) throw new RuntimeException('Cannot identify exported ' . strtolower($kind) . ' definition.');
    $dependencies = [];
    $contexts = ['header'];
    foreach ($positions as $position => $index) {
        $token = $tokens[$index];
        if ($token['kind'] === 'symbol' && $token['value'] === ';' && $position !== count($positions) - 1) throw new RuntimeException('Compound stored-program bodies are not supported by the playground snapshot importer.');
        if ($token['kind'] === 'symbol' && $token['value'] === '(') $contexts[] = end($contexts);
        elseif ($token['kind'] === 'symbol' && $token['value'] === ')' && count($contexts) > 1) array_pop($contexts);
        elseif ($token['kind'] === 'word') {
            $keyword = strtoupper($token['value']);
            if (in_array($keyword, ['FROM', 'JOIN'], true)) $contexts[array_key_last($contexts)] = 'from';
            elseif ($keyword === 'SELECT') $contexts[array_key_last($contexts)] = 'select';
            elseif (in_array($keyword, ['WHERE', 'ON', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION'], true)) $contexts[array_key_last($contexts)] = 'expression';
        }
        if ($position < $objectPosition && $token['kind'] === 'word' && strtoupper($token['value']) === 'DEFINER') {
            $equals = $positions[$position + 1] ?? null;
            $account = $positions[$position + 2] ?? null;
            if ($equals === null || $tokens[$equals]['value'] !== '=') continue;
            if ($account === null) throw new RuntimeException('Cannot export the SQL definer clause.');
            $endPosition = $position + 2;
            if (($tokens[$positions[$endPosition + 1] ?? -1]['value'] ?? null) === '@') $endPosition += 2;
            elseif (strtoupper($tokens[$account]['value']) === 'CURRENT_USER' && ($tokens[$positions[$endPosition + 1] ?? -1]['value'] ?? null) === '(') $endPosition += 2;
            $end = $positions[$endPosition] ?? null;
            if ($end === null) throw new RuntimeException('Cannot export the SQL definer account.');
            $tokens[$index]['raw'] = 'DEFINER=CURRENT_USER';
            for ($erase = $index + 1; $erase <= $end; ++$erase) $tokens[$erase]['raw'] = '';
        }
        if ($position <= $objectPosition || !in_array($token['kind'], ['identifier', 'word'], true)) continue;
        $next = $positions[$position + 1] ?? null;
        $object = $positions[$position + 2] ?? null;
        $previous = $tokens[$positions[$position - 1] ?? -1]['value'] ?? '';
        $previousKind = $tokens[$positions[$position - 1] ?? -1]['kind'] ?? '';
        if (end($contexts) === 'from' && $token['value'] === $schema && ($tokens[$next ?? -1]['value'] ?? null) !== '.'
            && (strtoupper($previous) === 'AS' || $previous === ')' || in_array($previousKind, ['identifier', 'word'], true))
            && !in_array(strtoupper($previous), ['FROM', 'JOIN'], true)) throw new RuntimeException('A view alias conflicts with its source database name. Rename that alias before exporting.');
        if (end($contexts) === 'from' && in_array(strtoupper($previous), ['FROM', 'JOIN', '(', ','], true)
            && in_array($token['value'], $viewNames, true) && ($tokens[$next ?? -1]['value'] ?? null) !== '.') $dependencies[] = $token['value'];
        if ($next === null || $object === null || $tokens[$next]['value'] !== '.' || !in_array($tokens[$object]['kind'], ['identifier', 'word'], true)) continue;
        if ($token['value'] === $schema) {
            $tokens[$index]['raw'] = '';
            $tokens[$next]['raw'] = '';
            if (in_array($tokens[$object]['value'], $viewNames, true) && $position > $objectPosition + 1) $dependencies[] = $tokens[$object]['value'];
        } elseif (in_array(strtoupper($previous), ['FROM', 'JOIN', 'UPDATE', 'INTO', 'REFERENCES'], true)) {
            throw new RuntimeException('Cross-database references cannot be included in a portable site export.');
        }
    }
    return ['sql' => implode('', array_column($tokens, 'raw')), 'dependencies' => array_values(array_unique($dependencies))];
}

function exportDatabase(JConfig $config, string $path): array
{
    if (!preg_match('/^[A-Za-z0-9_]+$/D', $config->db)) throw new RuntimeException('The database name cannot be exported.');
    $database = new PDO('mysql:dbname=' . $config->db . ';charset=utf8mb4', (string) $config->user, (string) $config->password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_STRINGIFY_FETCHES => true,
    ]);
    $objects = $database->query('SHOW FULL TABLES')->fetchAll(PDO::FETCH_NUM);
    foreach ($objects as $object) if (!in_array($object[1], ['BASE TABLE', 'VIEW'], true)) throw new RuntimeException('Unsupported database object: ' . $object[0] . ' (' . $object[1] . ').');
    $viewNames = array_column(array_filter($objects, static fn (array $object): bool => $object[1] === 'VIEW'), 0);
    $schema = $database->quote((string) $config->db);
    if ((int) $database->query('SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=' . $schema
        . ' AND REFERENCED_TABLE_SCHEMA IS NOT NULL AND REFERENCED_TABLE_SCHEMA<>' . $schema)->fetchColumn() !== 0) {
        throw new RuntimeException('Cross-database foreign keys cannot be included in a portable site export.');
    }
    foreach (['ROUTINES' => 'ROUTINE_SCHEMA', 'EVENTS' => 'EVENT_SCHEMA'] as $table => $column) {
        $systemTable = $table === 'ROUTINES' ? 'proc' : 'event';
        // The embedded engine omits these catalogs, so those stored objects
        // cannot exist there. When a catalog exists, inspect it normally.
        if ((int) $database->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='mysql' AND TABLE_NAME=" . $database->quote($systemTable))->fetchColumn() === 0) continue;
        if ((int) $database->query('SELECT COUNT(*) FROM information_schema.' . $table . ' WHERE ' . $column . '=' . $schema)->fetchColumn() !== 0) {
            throw new RuntimeException('Portable export cannot include stored ' . strtolower($table) . '. No partial export was produced.');
        }
    }
    $streams = ['sql' => fopen($path, 'wb'), 'ndjson' => fopen(dirname($path) . '/database.ndjson', 'wb')];
    if (in_array(false, $streams, true)) throw new RuntimeException('Cannot create the database export.');
    $size = 0;
    $rows = 0;
    $tables = [];
    $omitted = [];
    $views = [];
    $triggers = [];
    $originalSettings = $database->query('SELECT @@SESSION.sql_mode AS sql_mode, @@SESSION.sql_quote_show_create AS quote_identifiers')->fetch(PDO::FETCH_ASSOC);
    try {
        // Match SHOW CREATE escaping to the dump's import mode.
        $database->exec("SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'");
        $database->exec('SET SESSION sql_quote_show_create=1');
        $database->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        $database->beginTransaction();
        exportWrite($streams['sql'], "-- Joomla portable database export\n-- Import into an empty database selected by your database client.\n-- Browser login sessions are intentionally excluded.\n", $size);
        exportStatement($streams, 'SET NAMES utf8mb4', $size);
        exportStatement($streams, "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO'", $size);
        exportStatement($streams, 'SET FOREIGN_KEY_CHECKS=0', $size);
        foreach ($objects as [$name, $type]) {
            if ($type === 'VIEW') continue;
            $identifier = exportIdentifier($name);
            $definition = $database->query('SHOW CREATE TABLE ' . $identifier)->fetch(PDO::FETCH_NUM);
            if (!isset($definition[1]) || !is_string($definition[1])) throw new RuntimeException('Cannot read table schema: ' . $name);
            exportStatement($streams, 'DROP TABLE IF EXISTS ' . $identifier, $size);
            exportStatement($streams, $definition[1], $size);
            $tables[] = $name;
            if ($name === ($config->dbprefix ?? '') . 'session') {
                $omitted[] = $name;
                continue;
            }
            $columns = $database->query('SHOW FULL COLUMNS FROM ' . $identifier)->fetchAll(PDO::FETCH_ASSOC);
            $columns = array_values(array_filter($columns, static fn (array $column): bool => !preg_match('/(?:VIRTUAL|STORED|PERSISTENT)\s+GENERATED/i', $column['Extra'] ?? '')));
            if (!$columns) throw new RuntimeException('Cannot export a table without writable columns: ' . $name);
            $columnNames = implode(',', array_map(static fn (array $column): string => exportIdentifier($column['Field']), $columns));
            $projection = [];
            $encodings = [];
            foreach ($columns as $column) {
                $field = exportIdentifier($column['Field']);
                if (preg_match('/^bit\b/i', $column['Type'])) {
                    $projection[] = 'HEX(' . $field . ')';
                    $encodings[] = 'hex';
                } elseif (preg_match('/^(?:geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)\b/i', $column['Type'])) {
                    $projection[] = 'ST_AsWKB(' . $field . ')';
                    $projection[] = 'ST_SRID(' . $field . ')';
                    $encodings[] = 'geometry';
                } else {
                    $projection[] = $field;
                    $encodings[] = 'text';
                }
            }
            $primaryKey = $database->query("SHOW KEYS FROM " . $identifier . " WHERE Key_name='PRIMARY'")->fetchAll(PDO::FETCH_ASSOC);
            usort($primaryKey, static fn (array $left, array $right): int => (int) $left['Seq_in_index'] <=> (int) $right['Seq_in_index']);
            $ordering = $primaryKey ? implode(',', array_map(static fn (array $key): string => exportIdentifier($key['Column_name']), $primaryKey)) : $columnNames;
            $offset = 0;
            do {
                $batch = $database->query('SELECT ' . implode(',', $projection) . ' FROM ' . $identifier . ' ORDER BY ' . $ordering . ' LIMIT 250 OFFSET ' . $offset)->fetchAll(PDO::FETCH_NUM);
                $insert = 'INSERT INTO ' . $identifier . ' (' . $columnNames . ') VALUES ';
                $values = [];
                $valueBytes = 0;
                foreach ($batch as $row) {
                    $cells = [];
                    $position = 0;
                    foreach ($encodings as $encoding) {
                        $cell = $row[$position++];
                        if ($encoding === 'geometry') {
                            $srid = $row[$position++];
                            if ($cell !== null && (!is_string($srid) || !preg_match('/^[0-9]+$/D', $srid))) throw new RuntimeException('Cannot export a geometry SRID.');
                            $cells[] = $cell === null ? 'NULL' : "ST_GeomFromWKB(X'" . bin2hex((string) $cell) . "'," . $srid . ')';
                        } elseif ($encoding === 'hex') {
                            if ($cell !== null && (!is_string($cell) || !preg_match('/^[a-f0-9]*$/Di', $cell))) throw new RuntimeException('Cannot export a bit column.');
                            $cells[] = $cell === null ? 'NULL' : "X'" . (strlen($cell) % 2 ? '0' : '') . $cell . "'";
                        } else $cells[] = $cell === null ? 'NULL' : "X'" . bin2hex((string) $cell) . "'";
                    }
                    $tuple = '(' . implode(',', $cells) . ')';
                    // Keep the embedded server's parser stack bounded during
                    // snapshot replay; a single large value stays in one row.
                    if ($values && (count($values) >= 10 || (count($values) + 1) * count($columns) > 256
                        || $valueBytes + strlen($tuple) > 32 * 1024)) {
                        exportStatement($streams, $insert . implode(',', $values), $size);
                        $values = [];
                        $valueBytes = 0;
                    }
                    $values[] = $tuple;
                    $valueBytes += strlen($tuple);
                    ++$rows;
                }
                if ($values) exportStatement($streams, $insert . implode(',', $values), $size);
                $offset += count($batch);
            } while (count($batch) === 250);
            exportWrite($streams['sql'], "\n", $size);
        }
        foreach ($viewNames as $name) {
            $definition = $database->query('SHOW CREATE VIEW ' . exportIdentifier($name))->fetch(PDO::FETCH_NUM);
            $views[$name] = exportPortableDdl($definition[1], (string) $config->db, 'VIEW', 'NO_AUTO_VALUE_ON_ZERO', $viewNames);
        }
        $orderedViews = [];
        while ($views) {
            $progress = false;
            foreach ($views as $name => $definition) {
                if (array_intersect($definition['dependencies'], array_keys($views))) continue;
                exportStatement($streams, 'DROP VIEW IF EXISTS ' . exportIdentifier($name), $size);
                exportStatement($streams, $definition['sql'], $size);
                $orderedViews[] = $name;
                unset($views[$name]);
                $progress = true;
            }
            if (!$progress) throw new RuntimeException('Cannot resolve the exported view dependencies.');
        }
        $triggerRows = $database->query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=' . $schema . ' ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORDER')->fetchAll(PDO::FETCH_COLUMN);
        foreach ($triggerRows as $name) {
            $definition = $database->query('SHOW CREATE TRIGGER ' . exportIdentifier($name))->fetch(PDO::FETCH_ASSOC);
            $trigger = exportPortableDdl($definition['SQL Original Statement'], (string) $config->db, 'TRIGGER', $definition['sql_mode'], []);
            exportStatement($streams, 'SET SQL_MODE=' . $database->quote($definition['sql_mode']), $size);
            exportStatement($streams, 'DROP TRIGGER IF EXISTS ' . exportIdentifier($name), $size);
            exportStatement($streams, $trigger['sql'], $size);
            $triggers[] = $name;
        }
        exportStatement($streams, "SET SQL_MODE='NO_AUTO_VALUE_ON_ZERO'", $size);
        exportStatement($streams, 'SET FOREIGN_KEY_CHECKS=1', $size);
        $database->commit();
    } finally {
        try {
            if ($database->inTransaction()) $database->rollBack();
            $database->exec('SET SESSION sql_mode=' . $database->quote($originalSettings['sql_mode']));
            $database->exec('SET SESSION sql_quote_show_create=' . ((int) $originalSettings['quote_identifiers'] ? '1' : '0'));
        } finally { foreach ($streams as $stream) fclose($stream); }
    }
    return ['name' => $config->db, 'tablePrefix' => $config->dbprefix ?? '', 'tables' => $tables, 'views' => $orderedViews, 'triggers' => $triggers, 'rows' => $rows, 'bytes' => $size, 'omittedData' => $omitted, 'format' => 'mysql', 'statements' => 'database.ndjson'];
}

function exportConfiguration(JConfig $config, array $overrides): string
{
    $values = get_object_vars($config);
    $values['session_handler'] = 'database';
    $values['session_filesystem_path'] = '';
    $values['cookie_path'] = '';
    $values['cookie_domain'] = '';
    $values['live_site'] = '';
    $values['dbtype'] = 'mysql';
    foreach (['host' => 'host', 'user' => 'user', 'password' => 'password', 'name' => 'db'] as $input => $property) {
        if (array_key_exists($input, $overrides)) $values[$property] = $overrides[$input];
    }
    $contents = "<?php\n/** Portable Joomla configuration. Set database credentials for the destination server. */\nclass JConfig\n{\n";
    foreach ($values as $name => $value) {
        if (!preg_match('/^[a-zA-Z_][a-zA-Z0-9_]*$/D', $name)) throw new RuntimeException('The Joomla configuration contains an invalid property.');
        if ($name === 'log_path') $expression = "__DIR__ . '/administrator/logs'";
        elseif ($name === 'tmp_path') $expression = "__DIR__ . '/tmp'";
        else $expression = var_export($value, true);
        $contents .= '    public $' . $name . ' = ' . $expression . ";\n";
    }
    return $contents . "}\n";
}

function exportTransient(string $relative): bool
{
    if (preg_match('#(?:^|/)(?:\.git|\.svn)(?:/|$)#', $relative)) return true;
    foreach (['cache', 'administrator/cache', 'tmp', 'administrator/logs', 'logs'] as $directory) {
        if (str_starts_with($relative, $directory . '/')) {
            return !in_array(substr($relative, strlen($directory) + 1), ['index.html', '.htaccess', 'web.config'], true);
        }
    }
    return false;
}

function exportFiles(ZipArchive $zip, string $root, string $prefix, string $configuration): array
{
    $count = 0;
    $bytes = 0;
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
    foreach ($iterator as $entry) {
        $relative = substr($entry->getPathname(), strlen($root) + 1);
        if (exportTransient($relative)) continue;
        if ($entry->isLink()) throw new RuntimeException('Portable export does not support symbolic links inside the site: ' . $relative);
        $name = $prefix . $relative;
        if ($entry->isDir()) {
            if (!$zip->addEmptyDir($name)) throw new RuntimeException('Cannot add an export directory: ' . $relative);
            $zip->setExternalAttributesName($name . '/', ZipArchive::OPSYS_UNIX, 040755 << 16);
            continue;
        }
        if (!$entry->isFile()) throw new RuntimeException('Cannot export a special filesystem entry: ' . $relative);
        ++$count;
        $bytes += $relative === 'configuration.php' ? strlen($configuration) : $entry->getSize();
        if ($count > PLAYGROUND_EXPORT_FILES || $bytes > PLAYGROUND_EXPORT_LIMIT) throw new RuntimeException('The site export exceeds 100000 files or 768 MiB.');
        $added = $relative === 'configuration.php' ? $zip->addFromString($name, $configuration) : $zip->addFile($entry->getPathname(), $name);
        if (!$added) throw new RuntimeException('Cannot add an export file: ' . $relative);
        $zip->setExternalAttributesName($name, ZipArchive::OPSYS_UNIX, 0100644 << 16);
    }
    foreach (['cache', 'administrator/cache', 'tmp', 'administrator/logs'] as $directory) {
        if ($zip->locateName($prefix . $directory . '/') === false) $zip->addEmptyDir($prefix . $directory);
    }
    return ['count' => $count, 'bytes' => $bytes, 'excluded' => ['cache contents', 'temporary files', 'log files', 'browser sessions', 'private playground metadata', 'repository metadata']];
}

function exportInstructions(string $format): string
{
    $location = $format === 'bundle' ? 'Upload the contents of site/ to the destination webroot.' : 'Upload this archive’s Joomla files to the destination webroot.';
    return "# Deploy this Joomla site\n\n"
        . "1. Use a web server with a PHP version supported by this Joomla release, PDO MySQL, and Joomla’s required extensions.\n"
        . "2. Create an empty MariaDB or MySQL database and a database user with the privileges Joomla requires. Import database.sql into that database using the database client or hosting control panel. The dump does not create or select a database.\n"
        . '3. ' . $location . " Keep database.sql, export.json and these instructions outside the public webroot.\n"
        . "4. Set host, user, password and db in configuration.php to the destination connection details. The exported values retain the source settings unless target database overrides were supplied when exporting. Keep dbprefix unchanged.\n"
        . "5. Ensure PHP can write cache/, administrator/cache/, administrator/logs/ and tmp/. The exported configuration resolves its temporary and log paths relative to its own location.\n"
        . "6. Sign in using the site’s existing Joomla administrator account. Browser login sessions and the playground’s private credential metadata are excluded.\n\n"
        . "The archive uses ordinary Joomla files and SQL. The browser runtime and MariaDB bridge are not required on the destination server. Database sessions are enabled in the portable configuration. Views and triggers are owned by the account importing the dump; their SQL SECURITY mode is preserved. database.ndjson is the equivalent statement stream for verified playground snapshot imports.\n\n"
        . "This export contains site content, account password hashes and configuration values. Store it as a site backup.\n";
}

try {
    $directory = exportDirectory($exportOptions);
    if (($exportOptions['operation'] ?? '') === 'cleanup') {
        exportRemove($directory);
        exportFinish(['ok' => true]);
        return;
    }
    if (($exportOptions['operation'] ?? '') !== 'create') throw new InvalidArgumentException('Unknown export operation.');
    $root = realpath($exportOptions['root'] ?? '/persist/www');
    if ($root === false || !is_file($root . '/configuration.php') || is_dir($root . '/installation')) throw new RuntimeException('A completed Joomla installation is required for export.');
    $format = $exportOptions['format'] ?? 'bundle';
    if (!in_array($format, ['bundle', 'files', 'database'], true)) throw new InvalidArgumentException('Unknown export format.');
    if (is_dir($directory) || !mkdir($directory, 0700)) throw new RuntimeException('Cannot create the export directory.');
    require_once $root . '/configuration.php';
    $configuration = new JConfig();
    $manifest = simplexml_load_file($root . '/administrator/manifests/files/joomla.xml');
    if ($manifest === false) throw new RuntimeException('Cannot read the installed Joomla version.');
    $metadata = [
        'schemaVersion' => 1,
        'format' => 'joomengine-playground-export',
        'createdAt' => gmdate('c'),
        'joomlaVersion' => (string) $manifest->version,
        'phpVersion' => PHP_VERSION,
        'siteName' => $configuration->sitename,
        'archiveLayout' => $format === 'bundle' ? ['files' => 'site/', 'database' => 'database.sql'] : ['files' => $format === 'files' ? './' : null, 'database' => $format === 'database' ? 'database.sql' : null],
    ];
    if ($format !== 'files') $metadata['database'] = exportDatabase($configuration, $directory . '/database.sql');
    if ($format === 'database') {
        $path = $directory . '/database.sql';
    } else {
        $path = $directory . '/site.zip';
        $zip = new ZipArchive();
        if ($zip->open($path, ZipArchive::CREATE | ZipArchive::EXCL) !== true) throw new RuntimeException('Cannot create the site ZIP export.');
        try {
            $metadata['files'] = exportFiles($zip, $root, $format === 'bundle' ? 'site/' : '', exportConfiguration($configuration, $exportOptions['database'] ?? []));
            if ($format === 'bundle') {
                if ($metadata['files']['bytes'] + filesize($directory . '/database.sql') + filesize($directory . '/database.ndjson') > PLAYGROUND_EXPORT_LIMIT) throw new RuntimeException('The combined site export exceeds the 768 MiB extraction limit.');
                if (!$zip->addFile($directory . '/database.sql', 'database.sql') || !$zip->addFile($directory . '/database.ndjson', 'database.ndjson')) throw new RuntimeException('Cannot add the SQL dump to the site export.');
                if (!$zip->addFromString('export.json', json_encode($metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n")
                    || !$zip->addFromString('DEPLOYMENT.md', exportInstructions($format))) throw new RuntimeException('Cannot add export metadata.');
            }
        } finally {
            if (!$zip->close()) throw new RuntimeException('Cannot finish the site ZIP export.');
        }
    }
    clearstatcache(true, $path);
    $size = filesize($path);
    if ($size === false || $size < 1 || $size > PLAYGROUND_DOWNLOAD_LIMIT) throw new RuntimeException('The downloadable export exceeds the 512 MiB limit or could not be written.');
    $stem = trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($configuration->sitename)), '-') ?: 'joomla-site';
    $filename = substr($stem, 0, 80) . '-' . $format . '-' . gmdate('Y-m-d-His') . ($format === 'database' ? '.sql' : '.zip');
    exportFinish(['ok' => true, 'path' => $path, 'size' => $size, 'sha256' => hash_file('sha256', $path), 'filename' => $filename, 'metadata' => $metadata]);
} catch (Throwable $error) {
    if (isset($directory)) {
        try { exportRemove($directory); } catch (Throwable $ignored) { }
    }
    exportFinish(['ok' => false, 'error' => $error->getMessage()]);
}
