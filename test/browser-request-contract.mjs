import assert from 'node:assert/strict';

/** Exercise the actual service worker, PHP worker and browser CGI input path. */
export async function assertBrowserRequestBodies(page) {
  const result = await page.evaluate(async () => {
    const runtime = window.playground;
    const filename = `request-contract-${crypto.randomUUID()}.php`;
    const path = `/persist/www/${filename}`;
    await runtime.fs.writeFile(path, `<?php
      header('Content-Type: application/json'); $body = file_get_contents('php://input');
      echo json_encode(['method' => $_SERVER['REQUEST_METHOD'], 'hash' => hash('sha256', $body),
        'size' => strlen($body), 'type' => $_SERVER['CONTENT_TYPE'], 'post' => $_POST,
        'file' => isset($_FILES['package']) ? ['size' => $_FILES['package']['size'], 'error' => $_FILES['package']['error'], 'hash' => hash_file('sha256', $_FILES['package']['tmp_name'])] : null], JSON_THROW_ON_ERROR);`);
    const bytes = new Uint8Array([0, 255, 128, ...new TextEncoder().encode('Rocket — 中文')]);
    const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
    const request = async (method, body, headers) => {
      const response = await fetch(new URL(filename, runtime.baseUrl), { method, body, headers });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`Browser CGI body request returned ${response.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    };
    try {
      const methods = [];
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        methods.push(await request(method, bytes, { 'Content-Type': 'application/octet-stream' }));
      }
      const form = await request('POST', 'name=Afrikaans&value=%E4%B8%AD%E6%96%87', { 'Content-Type': 'application/x-www-form-urlencoded' });
      const upload = new Uint8Array(1024 * 1024); upload.fill(165); upload[0] = 0; upload[upload.length - 1] = 255;
      const multipart = new FormData(); multipart.append('package', new Blob([upload]), 'component.zip'); multipart.append('name', 'JCB');
      return { methods, hash: await digest(bytes), size: bytes.byteLength, form, multipart: await request('POST', multipart), uploadHash: await digest(upload) };
    } finally { await runtime.fs.unlink(path); }
  });
  for (const [index, method] of ['POST', 'PUT', 'PATCH', 'DELETE'].entries()) {
    assert.equal(result.methods[index].method, method);
    assert.equal(result.methods[index].hash, result.hash);
    assert.equal(result.methods[index].size, result.size);
    assert.equal(result.methods[index].type, 'application/octet-stream');
  }
  assert.deepEqual(result.form.post, { name: 'Afrikaans', value: '中文' });
  assert.deepEqual(result.multipart.post, { name: 'JCB' });
  assert.deepEqual(result.multipart.file, { size: 1024 * 1024, error: 0, hash: result.uploadHash });
}
