<?php
/** Browser HTTP streams use the same Fetch-backed cURL transport as Joomla. */
declare(strict_types=1);

namespace JoomEngine\Rocket;

require_once '/internal/mariadb.php';

final class HttpResponse
{
    public array $context = [];
    public string $error = '';
    public bool $headersOnly = false;
    private bool $headersComplete = false;
    /** The native adapter publishes these through PHP's ordinary stream metadata. */
    public array $headers = [];
    public int $status = 0;
    private $buffer;
    private int $size = 0;
    private int $limit = 0;

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        if (!in_array($mode, ['r', 'rb', 'rt'], true)) {
            return $this->fail('HTTP streams are read-only.', $options);
        }
        $settings = $this->context;
        $http = $settings['http'] ?? [];
        $ssl = $settings['ssl'] ?? [];
        if (!empty($http['proxy']) || !empty($http['request_fulluri'])) {
            return $this->fail('HTTP proxies must be configured by the browser, not PHP.', $options);
        }
        // Browser TLS has its own trust store and cannot present client certificates.
        foreach (['cafile', 'capath', 'local_cert', 'local_pk', 'peer_fingerprint', 'peer_name'] as $unsupported) {
            if (isset($ssl[$unsupported])) {
                return $this->fail('The browser cannot apply the requested TLS option: ' . $unsupported, $options);
            }
        }
        $method = strtoupper((string) ($http['method'] ?? 'GET'));
        if (!preg_match("/^[A-Z0-9!#$%&'*+.^_`|~-]+$/D", $method)
            || !in_array(strtolower((string) parse_url($path, PHP_URL_SCHEME)), ['http', 'https'], true)) {
            return $this->fail('Invalid HTTP stream request.', $options);
        }
        $timeout = (float) ($http['timeout'] ?? ini_get('default_socket_timeout'));
        if (!is_finite($timeout) || $timeout <= 0) return $this->fail('HTTP timeout must be positive.', $options);
        $headers = $http['header'] ?? [];
        if (is_string($headers)) $headers = preg_split('/\r?\n/', trim($headers), -1, PREG_SPLIT_NO_EMPTY);
        if (!is_array($headers)) return $this->fail('HTTP headers must be a string or array.', $options);
        foreach ($headers as $header) {
            if (!is_string($header) || str_contains($header, "\r") || str_contains($header, "\n")) {
                return $this->fail('Invalid HTTP header.', $options);
            }
        }
        $this->buffer = fopen('php://temp/maxmemory:2097152', 'w+b');
        if ($this->buffer === false) return $this->fail('Cannot allocate the HTTP response stream.', $options);
        // The Fetch result and the virtual temporary file both consume browser memory.
        // Reserve headroom for these copies and the caller's resulting PHP string.
        $memory = self::iniBytes((string) ini_get('memory_limit'));
        $upload = self::iniBytes((string) ini_get('upload_max_filesize'));
        $available = $memory > 0 ? max(0, $memory - memory_get_usage(true)) : 512 * 1024 * 1024;
        $this->limit = min($upload > 0 ? $upload : 128 * 1024 * 1024, intdiv($available, 4));
        $curl = curl_init($path);
        if ($curl === false) { $this->stream_close(); return $this->fail('Cannot create the HTTP request.', $options); }
        $curlOptions = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_FOLLOWLOCATION => (bool) ($http['follow_location'] ?? true),
            CURLOPT_MAXREDIRS => max(0, (int) ($http['max_redirects'] ?? 20)),
            CURLOPT_TIMEOUT_MS => max(1, (int) ceil($timeout * 1000)),
            CURLOPT_HTTPHEADER => array_values($headers),
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HEADERFUNCTION => function ($handle, string $header): int {
                $line = rtrim($header, "\r\n");
                if ($line === '' && $this->headersOnly) { $this->headersComplete = true; return 0; }
                if (!$this->headersOnly && preg_match('/^Content-Length:\s*(\d+)/i', $line, $match) && (float) $match[1] > $this->limit) {
                    $this->error = 'HTTP response exceeds the available PHP memory and upload budget.';
                    return 0;
                }
                if ($line !== '') $this->headers[] = $line;
                return strlen($header);
            },
            CURLOPT_WRITEFUNCTION => function ($handle, string $bytes): int {
                if ($this->headersOnly) return strlen($bytes);
                if (strlen($bytes) > $this->limit - $this->size) {
                    $this->error = 'HTTP response exceeds the available PHP memory and upload budget.';
                    return 0;
                }
                $written = fwrite($this->buffer, $bytes);
                if ($written === false) return 0;
                $this->size += $written;
                return $written;
            },
        ];
        if ($method === 'HEAD') $curlOptions[CURLOPT_NOBODY] = true;
        if (array_key_exists('content', $http)) $curlOptions[CURLOPT_POSTFIELDS] = (string) $http['content'];
        if (isset($http['user_agent'])) $curlOptions[CURLOPT_USERAGENT] = (string) $http['user_agent'];
        elseif (ini_get('user_agent') !== '') $curlOptions[CURLOPT_USERAGENT] = ini_get('user_agent');
        try {
            if (!curl_setopt_array($curl, $curlOptions)) throw new \RuntimeException('Cannot apply HTTP request options.');
            $success = curl_exec($curl);
            $this->status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
            if ($success === false && !($this->headersOnly && $this->headersComplete && curl_errno($curl) === CURLE_WRITE_ERROR)) {
                throw new \RuntimeException($this->error !== '' ? $this->error : curl_error($curl));
            }
            if (!$this->headersOnly && $this->status >= 400 && empty($http['ignore_errors'])) {
                throw new \RuntimeException('HTTP request returned status ' . $this->status . '.');
            }
        } catch (\Throwable $error) {
            $this->stream_close();
            return $this->fail($error->getMessage(), $options);
        } finally {
            // CurlHandle releases its resources on destruction, including on PHP 8.5.
            unset($curl);
        }
        rewind($this->buffer);
        $openedPath = $path;
        return true;
    }

    private function fail(string $message, int $options): bool
    {
        $this->error = $message;
        return false;
    }

    private static function iniBytes(string $value): int
    {
        $number = (float) $value;
        $unit = strtolower(substr(trim($value), -1));
        $factor = match ($unit) { 'g' => 1073741824, 'm' => 1048576, 'k' => 1024, default => 1 };
        return (int) min(PHP_INT_MAX, $number * $factor);
    }

    public function body(): string { return (string) stream_get_contents($this->buffer); }
    public function stream_close(): void
    {
        if (is_resource($this->buffer)) fclose($this->buffer);
        $this->buffer = null;
    }
}

/** Called by the native stream adapter; no userland replacement of PHP stream semantics. */
function httpOpen(string $path, string $mode, int $options, array $context, bool $headersOnly): array
{
    $response = new HttpResponse();
    $response->context = $context;
    $response->headersOnly = $headersOnly;
    $openedPath = null;
    try {
        $ok = $response->stream_open($path, $mode, $options, $openedPath);
        return ['body' => $ok ? $response->body() : false, 'headers' => $response->headers, 'error' => $response->error];
    } finally { $response->stream_close(); }
}
