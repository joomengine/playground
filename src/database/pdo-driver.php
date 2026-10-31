} elseif (extension_loaded("pdo_mariadb_wasm")) {
    // JoomEngine adapter for the embedded PDO mysql driver. No native mysql
    // extension constants, sockets, passwords or network connections are used.
    class Db extends PdoDb {
        public $extension = "PDO MariaDB WASM";

        function attach(array $server, $username, $password) {
            if ($username !== 'root' || $password !== '' || $server['host'] !== '') {
                return 'Only the active Playground database is available.';
            }
            return $this->dsn(
                'mysql:dbname=' . JOOMENGINE_DATABASE . ';charset=utf8mb4',
                'root',
                '',
                array(\PDO::ATTR_EMULATE_PREPARES => true)
            );
        }

        function set_charset($charset) {
            return $this->query("SET NAMES utf8mb4");
        }

        function select_db($database) {
            if ($database !== JOOMENGINE_DATABASE) {
                $this->error = 'Only the active Playground database is available.';
                return false;
            }
            return $this->query('USE ' . idf_escape($database));
        }

        function query($query, $unbuffered = false) {
            // The embedded transport buffers bounded result sets. It has no
            // PDO::MYSQL_ATTR_USE_BUFFERED_QUERY/native mysql-client attribute.
            return parent::query($query, false);
        }
    }

    class JoomEnginePdoResult extends PdoResult {
        function fetch_field() {
            $metadata = $this->getColumnMeta($this->_offset++);
            $metadata['type'] = $metadata['mariadb:type'];
            $metadata['charsetnr'] = $metadata['mariadb:charset'];
            $metadata['flags'] = $metadata['mariadb:flags'];
            // Source tables are unavailable in this bridge. Do not fabricate
            // an editable origin for query-result cells; table editing works.
            $metadata['orgtable'] = '';
            return (object) $metadata;
        }
    }

}
