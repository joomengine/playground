export const callbackSource = `<?php
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
$db->exec('INSERT INTO http_self_request (id) VALUES (1)');
file_put_contents('/persist/www/self-request-result.txt', 'child-complete');
header('Content-Type: application/json');
setcookie('child_callback', 'response-cookie');
http_response_code(201);
echo json_encode(['body'=>base64_encode(file_get_contents('php://input')),
    'cookie'=>$_COOKIE['callback'] ?? '', 'header'=>$_SERVER['HTTP_X_CALLBACK'] ?? '',
    'method'=>$_SERVER['REQUEST_METHOD'], 'ownerCookie'=>$_COOKIE['owner_cookie'] ?? '']);
`;

export function selfRequestSource(siteURL) {
  return `<?php
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
$db->exec('CREATE TABLE http_self_request (id INT PRIMARY KEY)');
$db->beginTransaction();
$db->exec('INSERT INTO http_self_request (id) VALUES (2)');
$curl = curl_init(${JSON.stringify(new URL('self-request-redirect.php', siteURL).href)});
curl_setopt_array($curl, [CURLOPT_POST=>true, CURLOPT_POSTFIELDS=>base64_decode('AP9BgAo='),
    CURLOPT_HTTPHEADER=>['Content-Type: application/octet-stream','X-Callback: exact-header','Cookie: callback=exact-cookie'],
    CURLOPT_RETURNTRANSFER=>true, CURLOPT_FOLLOWLOCATION=>true, CURLOPT_TIMEOUT=>60]);
$body = curl_exec($curl);
$error = curl_error($curl);
$status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$redirects = curl_getinfo($curl, CURLINFO_REDIRECT_COUNT);
$transaction = $db->inTransaction();
$db->rollBack();
$rows = $db->query('SELECT id FROM http_self_request ORDER BY id')->fetchAll(PDO::FETCH_COLUMN);
$stream = file_get_contents(${JSON.stringify(new URL('self-request-result.txt', siteURL).href)});
echo json_encode(['response'=>$body === false ? false : json_decode($body,true), 'error'=>$error,
    'status'=>$status,'redirects'=>$redirects,'transaction'=>$transaction,'rows'=>$rows,
    'stream'=>$stream,'parentResumed'=>true]);
`;
}

export const redirectSource = "<?php header('Location: self-request-callback.php', true, 307);";

export function cancelledCallbackSource(slowURL) {
  return `<?php
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
$db->exec('INSERT INTO http_self_request (id) VALUES (3)');
$db->beginTransaction();
$db->exec('INSERT INTO http_self_request (id) VALUES (4)');
file_put_contents('/persist/www/self-cancel-result.txt', 'child-before-cancel');
$curl = curl_init(${JSON.stringify(slowURL)});
curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>60]);
curl_exec($curl);
file_put_contents('/persist/www/self-cancel-result.txt', 'late-child-write');
`;
}

export function cancellationSource(siteURL, timeoutMs) {
  return `<?php
$db = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '');
$db->beginTransaction();
$db->exec('INSERT INTO http_self_request (id) VALUES (5)');
$curl = curl_init(${JSON.stringify(new URL('self-request-cancel.php', siteURL).href)});
curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT_MS=>${timeoutMs}]);
$body = curl_exec($curl);
$transaction = $db->inTransaction();
$db->rollBack();
$previous = @file_get_contents('/persist/www/self-cancel-result.txt');
file_put_contents('/persist/www/self-cancel-result.txt', 'parent-after-cancel');
echo json_encode(['failed'=>$body===false,'errno'=>curl_errno($curl),'transaction'=>$transaction,
    'previous'=>$previous,'rows'=>$db->query('SELECT id FROM http_self_request ORDER BY id')->fetchAll(PDO::FETCH_COLUMN)]);
`;
}

export function assertCancelledRequest(assert, result) {
  assert.equal(result.failed, true);
  assert.notEqual(result.errno, 0);
  assert.equal(result.transaction, true);
  assert.equal(result.previous, 'child-before-cancel', JSON.stringify(result));
  assert.deepEqual(result.rows.map(Number), [1, 3], 'Cancel rolls back only the child\'s unfinished transaction.');
}

export function assertSelfRequest(assert, result) {
  assert.deepEqual(result.response, { body: 'AP9BgAo=', cookie: 'exact-cookie', header: 'exact-header', method: 'POST', ownerCookie: '' });
  assert.equal(result.error, '');
  assert.equal(result.status, 201);
  assert.equal(result.redirects, 1);
  assert.equal(result.transaction, true, 'The child must not reset its suspended caller\'s database connection.');
  assert.deepEqual(result.rows.map(Number), [1], 'Only the child committed; the caller rolled its own transaction back.');
  assert.equal(result.stream, 'child-complete');
  assert.equal(result.parentResumed, true);
}
