const PATHS = { model: '/administrator/components/com_config/src/Model/ApplicationModel.php', console: '/libraries/src/Console/SetConfigurationCommand.php' };
const REFERENCES = [
  { kind: 'model', version: '5.4.10', sha256: 'f53ce977b42d0c373660fe4c4cb22313b8ad972809c76afdda266cad01336cee',
    connection: '$revisedDbo = DatabaseDriver::getInstance($options);' },
  { kind: 'console', version: '5.4.10', sha256: '7de63a108161b5d57414c1f93a49a8889b7aaa8c9dc6c6f886d4aa4da9ff5e95',
    connection: '$db = DatabaseDriver::getInstance($settings);' },
  { kind: 'console', version: '6.2.0', sha256: '7b57dab5a8c1a3215c4febaa8b91a763e67f0fe3a52970da15f0b160759d17cd',
    connection: "$db = (new DatabaseFactory())->getDriver($settings['driver'], $settings);" },
  { kind: 'model', version: '6.2.0', sha256: '4c818d664dccb05f12a19930275cd7b3cc64ad54c7b1a98bfd1e7b6d9314abf3',
    connection: "$revisedDbo = (new DatabaseFactory())->getDriver($options['driver'], $options);" },
];
const marker = '// Rocket managed browser database validation.';
const encoder = new TextEncoder();
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function original(reference) {
  return `            ${reference.connection}\n            ${reference.kind === 'console' ? '$db' : '$revisedDbo'}->getVersion();`;
}
function previousReplacement(reference) {
  const data = reference.kind === 'console' ? '$options' : '$data';
  const database = reference.kind === 'console' ? '$db' : '$revisedDbo';
  const driver = reference.kind === 'console' ? '\\Joomla\\CMS\\Factory::getContainer()->get(\\Joomla\\Database\\DatabaseInterface::class)' : '$this->getDatabase()';
  return `            ${marker}
            if (\\extension_loaded('pdo_mariadb_wasm')) {
                $managed = new \\JConfig();
                foreach (['dbtype', 'host', 'user', 'password', 'db', 'dbprefix', 'dbencryption',
                    'dbsslverifyservercert', 'dbsslkey', 'dbsslcert', 'dbsslca', 'dbsslcipher',
                    'session_handler', 'session_filesystem_path'] as $field) {
                    $expected = $managed->$field ?? '';
                    if (array_key_exists($field, ${data}) && ${data}[$field] != $expected) {
                        throw new \\RuntimeException('The browser manages the database and session settings. Export the site to change them on another server.');
                    }
                    ${data}[$field] = $expected;
                }
                ${database} = ${driver};
                ${database}->getVersion();
            } else {
                ${reference.connection}
                ${database}->getVersion();
            }`;
}

function replacement(reference) {
  const data = reference.kind === 'console' ? '$options' : '$data';
  return `            ${marker}
            if (\\extension_loaded('pdo_mariadb_wasm')) {
                $managed = new \\JConfig();
                foreach (['dbtype', 'host', 'user', 'password', 'db', 'dbprefix', 'dbencryption',
                    'dbsslverifyservercert', 'dbsslkey', 'dbsslcert', 'dbsslca', 'dbsslcipher',
                    'session_handler', 'session_filesystem_path'] as $field) {
                    $expected = $managed->$field ?? '';
                    if (array_key_exists($field, ${data}) && ${data}[$field] != $expected) {
                        throw new \\RuntimeException('The browser manages the database and session settings. Export the site to change them on another server.');
                    }
                    ${data}[$field] = $expected;
                }
            }
${original(reference)}`;
}

/** Protect browser-owned connection settings while preserving Joomla's own connection validation. */
export async function managedDatabaseSource(source, version, kind = 'model') {
  const reviewed = REFERENCES.filter(item => item.kind === kind);
  const exact = reviewed.filter(item => item.version === version);
  // A new Joomla release can reuse an existing adapter only when the *entire*
  // source file is byte-for-byte identical to a reviewed reference. This lets
  // unchanged development snapshots use the guard without weakening it to a
  // best-effort text match. For a pinned release, keep its exact reference.
  const candidates = exact.length ? exact : reviewed;
  const hasMarker = source.includes(marker);
  const sourceDigest = hasMarker ? null : await digest(source);
  for (const reference of candidates) {
    const before = original(reference);
    const after = replacement(reference);
    const previous = previousReplacement(reference);
    if (hasMarker) {
      if (source.includes(previous) && await digest(source.replace(previous, before)) === reference.sha256) {
        return { source: source.replace(previous, after), changed: true, sourceSha256: reference.sha256 };
      }
      if (source.includes(after) && await digest(source.replace(after, before)) === reference.sha256) {
        return { source, changed: false, sourceSha256: reference.sha256 };
      }
    } else if (sourceDigest === reference.sha256 && source.split(before).length === 2) {
      return { source: source.replace(before, after), changed: true, sourceSha256: reference.sha256 };
    }
  }
  throw new Error('The Joomla configuration model does not match a reviewed source checksum; its source must be reviewed before adapting it.');
}

export async function ensureManagedDatabaseConfiguration(runtime, version) {
  const prepared = [];
  for (const [kind, relative] of Object.entries(PATHS)) {
    const path = (runtime.documentRoot ?? '/persist/www') + relative;
    const data = await runtime.fs.readFile(path);
    const source = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data);
    prepared.push({ path, ...await managedDatabaseSource(source, version, kind) });
  }
  // Verify every affected source before changing either file.
  for (const result of prepared) if (result.changed) await runtime.fs.writeFile(result.path, result.source);
  return { managedDatabase: true, sources: prepared.map(({ path, sourceSha256 }) => ({ path, sourceSha256 })) };
}
