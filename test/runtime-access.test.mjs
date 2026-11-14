import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeAccess } from '../src/runtime-access.mjs';

function fixture() {
  const state = { changing: false, closing: false }, calls = [];
  const access = createRuntimeAccess({
    send: async (operation, args) => { calls.push({ operation, args }); return { status: 200, headers: [], body: new Uint8Array() }; },
    siteUrl: 'https://playground.example/__site/test/', requestTimeout: () => 120_000,
    isChanging: () => state.changing, isClosing: () => state.closing, requireDatabase: () => {},
  });
  return { state, calls, ...access };
}

test('SDK writes cannot enter the old site after a transition checkpoint while internal restore proceeds', async () => {
  const access = fixture();
  await access.public.fs.writeFile('/before', 'kept');
  access.state.changing = true;
  await Promise.all([
    assert.rejects(access.public.fs.writeFile('/late', 'lost'), /current site operation/),
    assert.rejects(access.public.runPhp('<?php file_put_contents("/late", "lost");'), /current site operation/),
    assert.rejects(access.public.request('/save', { method: 'POST', body: 'lost' }), /current site operation/),
    assert.rejects(access.public.fs.readFile('/before'), /current site operation/),
  ]);
  await access.internal.runPhp('<?php /* restore */');
  await access.internal.fs.writeFile('/restored', 'kept');
  assert.deepEqual(access.calls.map(value => value.operation), ['fs.writeFile', 'runPhp', 'fs.writeFile']);
  access.state.changing = false;
  await access.public.fs.writeFile('/after', 'kept');
  assert.equal(access.calls.at(-1).args.path, '/after');
});

test('an SDK request whose body finishes during a transition is rejected before dispatch', async () => {
  const access = fixture();
  let body;
  const stream = new ReadableStream({ start(controller) { body = controller; } });
  const request = access.public.request('/save', { method: 'POST', body: stream, duplex: 'half' });
  const rejected = assert.rejects(request, /current site operation/);
  access.state.changing = true;
  body.enqueue(new TextEncoder().encode('late mutation'));
  body.close();
  await rejected;
  assert.equal(access.calls.length, 0);
});

test('the private provisioning facade cannot send work once closing starts', async () => {
  const access = fixture();
  access.state.closing = true;
  await Promise.all([
    assert.rejects(access.internal.fs.writeFile('/late', ''), /closing/),
    assert.rejects(access.internal.runPhp('<?php'), /closing/),
    assert.rejects(access.internal.request('/'), /closing/),
  ]);
  assert.equal(access.calls.length, 0);
});
