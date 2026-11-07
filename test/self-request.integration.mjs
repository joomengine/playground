import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeRuntime } from '../scripts/node-runtime.mjs';
import { createServer } from 'node:http';
import { callbackSource, redirectSource, selfRequestSource, assertSelfRequest, cancelledCallbackSource, cancellationSource, assertCancelledRequest } from './self-request-contract.mjs';

test('native PHP HTTP callbacks execute independently and preserve caller transactions', { timeout: 180_000 }, async t => {
  const runtime = await createNodeRuntime({ phpVersion: '8.4' });
  t.after(() => runtime.close());
  await runtime.fs.writeFile('/persist/www/self-request-callback.php', callbackSource);
  await runtime.fs.writeFile('/persist/www/self-request-redirect.php', redirectSource);
  await runtime.runPhp("<?php setcookie('owner_cookie', 'retain');");
  const response = await runtime.runPhp(selfRequestSource(runtime.baseUrl));
  assert.equal(response.status, 200, response.text);
  assertSelfRequest(assert, JSON.parse(response.text));
  assert.deepEqual(JSON.parse((await runtime.runPhp("<?php echo json_encode([$_COOKIE['owner_cookie'] ?? '', isset($_COOKIE['child_callback'])]);")).text), ['retain', false]);
  const slow = createServer(() => {});
  await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
  t.after(async () => { slow.closeAllConnections(); await new Promise(resolve => slow.close(resolve)); });
  await runtime.fs.writeFile('/persist/www/self-request-cancel.php', cancelledCallbackSource(`http://127.0.0.1:${slow.address().port}/slow`));
  assertCancelledRequest(assert, JSON.parse((await runtime.runPhp(cancellationSource(runtime.baseUrl, 5000))).text));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(new TextDecoder().decode(await runtime.fs.readFile('/persist/www/self-cancel-result.txt')), 'parent-after-cancel');
  assert.equal((await runtime.runPhp('<?php echo 6 * 7;')).text, '42');
});
