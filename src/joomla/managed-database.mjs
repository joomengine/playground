const MODEL = '/administrator/components/com_config/src/Model/ApplicationModel.php';
const REFERENCES = [
  { version: '5.4.10', sha256: 'f53ce977b42d0c373660fe4c4cb22313b8ad972809c76afdda266cad01336cee',
    connection: '$revisedDbo = DatabaseDriver::getInstance($options);' },
  { version: '6.2.0', sha256: '4c818d664dccb05f12a19930275cd7b3cc64ad54c7b1a98bfd1e7b6d9314abf3',
    connection: "$revisedDbo = (new DatabaseFactory())->getDriver($options['driver'], $options);" },
];
const marker = '// Rocket managed browser database validation.';
const encoder = new TextEncoder();
async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}
function original(reference) {
  return `            ${reference.connection}\n            $revisedDbo->getVersion();`;
}
function replacement(reference) {
  return `            ${marker}
            if (\\extension_loaded('pdo_mariadb_wasm')) {
                $managed = new \\JConfig();
                foreach (['dbtype', 'host', 'user', 'password', 'db', 'dbprefix', 'dbencryption',
                    'dbsslverifyservercert', 'dbsslkey', 'dbsslcert', 'dbsslca', 'dbsslcipher',
                    'session_handler', 'session_filesystem_path'] as $field) {
                    $expected = $managed->$field ?? '';
                    if (array_key_exists($field, $data) && $data[$field] != $expected) {
                        throw new \\RuntimeException('The browser manages the database and session settings. Export the site to change them on another server.');
                    }
                    $data[$field] = $expected;
                }
                $revisedDbo = $this->getDatabase();
                $revisedDbo->getVersion();
            } else {
                ${reference.connection}
                $revisedDbo->getVersion();
            }`;
}

/** Preserve Joomla's native save flow while validating its existing managed browser connection. */
export async function managedDatabaseSource(source, version) {
  const reference = REFERENCES.find(item => item.version === version);
  if (!reference) throw new Error('This Joomla release has no reviewed browser database configuration adapter.');
  const before = original(reference);
  const after = replacement(reference);
  if (source.includes(marker)) {
    if (!source.includes(after) || await digest(source.replace(after, before)) !== reference.sha256) {
      throw new Error('The managed Joomla configuration model has changed; its source must be reviewed before adapting it.');
    }
    return { source, changed: false, sourceSha256: reference.sha256 };
  }
  if (await digest(source) !== reference.sha256 || source.split(before).length !== 2) {
    throw new Error('The Joomla configuration model does not match its reviewed source checksum.');
  }
  return { source: source.replace(before, after), changed: true, sourceSha256: reference.sha256 };
}

export async function ensureManagedDatabaseConfiguration(runtime, version) {
  const path = (runtime.documentRoot ?? '/persist/www') + MODEL;
  const data = await runtime.fs.readFile(path);
  const source = typeof data === 'string' ? data : new TextDecoder('utf-8', { fatal: true }).decode(data);
  const result = await managedDatabaseSource(source, version);
  if (result.changed) await runtime.fs.writeFile(path, result.source);
  return { managedDatabase: true, sourceSha256: result.sourceSha256 };
}
