import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatProvider, AI_PROVIDER_CANDIDATES } from '../src/code/ai-provider.mjs';
import { createAiReview, createAiWorkspaceTools, isSensitiveAiPath } from '../src/code/ai-review.mjs';
import { createWorkspaceFileService } from '../src/code/workspace-files.mjs';

const encoder = new TextEncoder();
const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function streamResponse(events, { chunkSize = 7, done = true } = {}) {
  const text = ': heartbeat\r\n\r\n' + events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
const delta = (value, finish = null) => ({ choices: [{ index: 0, delta: value, finish_reason: finish }] });
const settings = { baseURL: 'https://provider.invalid/v1/', model: 'tool-model', apiKey: 'secret-session-key' };
function fixture({ dirty = () => false, overrides = {}, reserve = callback => callback() } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jec-ai-')); temporary.push(directory);
  fs.mkdirSync(path.join(directory, 'templates'));
  fs.writeFileSync(path.join(directory, 'index.php'), '<?php echo "before";\r\n');
  fs.writeFileSync(path.join(directory, 'templates/site.css'), 'body { color: red; }');
  fs.writeFileSync(path.join(directory, 'configuration.php'), '<?php $password="secret";');
  fs.writeFileSync(path.join(directory, '.env'), 'TOKEN=secret');
  const adapter = { lstat: fs.lstatSync, stat: fs.statSync, readlink: fs.readlinkSync, readdir: fs.readdirSync,
    readFile: filename => new Uint8Array(fs.readFileSync(filename)), writeFile: fs.writeFileSync,
    mkdir: fs.mkdirSync, rmdir: fs.rmdirSync, unlink: fs.unlinkSync, rename: fs.renameSync, symlink: fs.symlinkSync,
    chmod: fs.chmodSync, utime: (filename, atime, mtime) => fs.utimesSync(filename, new Date(atime), new Date(mtime)), ...overrides };
  const service = createWorkspaceFileService(adapter, directory);
  let applied = 0;
  const workspace = { request: (operation, args) => service.handle(operation, args),
    withBatch: callback => reserve(() => callback({ request: workspace.request })) };
  const review = createAiReview({ workspace, isDirty: dirty, onApplied: () => { applied++; } });
  return { directory, workspace, review, applied: () => applied };
}

test('provider assembles fragmented UTF-8 SSE text and streamed tool calls without executing them', async () => {
  let request, text = '';
  const provider = createChatProvider({ ...settings, fetcher: async (url, init) => {
    request = { url, ...init };
    return streamResponse([
      delta({ content: 'Joomla ✓' }),
      delta({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"/index.php"}' } }] }),
      delta({}, 'tool_calls'), { choices: [], usage: { total_tokens: 10 } },
    ], { chunkSize: 1 });
  } });
  const result = await provider.stream({ messages: [{ role: 'user', content: 'Read the file' }], onDelta: value => { text += value; } });
  assert.equal(request.url, 'https://provider.invalid/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer secret-session-key');
  assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
  assert.equal(text, 'Joomla ✓');
  assert.deepEqual(result.tool_calls[0], { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/index.php"}' } });
  assert.equal(JSON.stringify(result).includes(settings.apiKey), false);
  provider.dispose();
  await assert.rejects(provider.stream({ messages: [{ role: 'user', content: 'again' }] }), { code: 'CLOSED' });
});

test('provider rejects incomplete or truncated tool streams and redacts HTTP error bodies', async () => {
  const messages = [{ role: 'user', content: 'test' }];
  for (const response of [streamResponse([delta({ content: 'partial' })], { done: false }), streamResponse([delta({}, 'length')])]) {
    const provider = createChatProvider({ ...settings, fetcher: async () => response });
    await assert.rejects(provider.stream({ messages }), { code: 'INCOMPLETE_STREAM' });
  }
  const provider = createChatProvider({ ...settings, fetcher: async () => new Response(`bad ${settings.apiKey}`, { status: 401 }) });
  await assert.rejects(provider.stream({ messages }), error => error.code === 'HTTP_401' && !error.message.includes(settings.apiKey));
  const network = createChatProvider({ ...settings, fetcher: async () => { throw Object.assign(new Error(settings.apiKey), { code: 'ERR_NETWORK' }); } });
  await assert.rejects(network.stream({ messages }), error => error.code === 'NETWORK_ERROR' && !error.message.includes(settings.apiKey));
});

test('provider cancels the underlying streaming fetch and never treats cancellation as success', async () => {
  let actualSignal;
  const controller = new AbortController();
  const provider = createChatProvider({ ...settings, fetcher: async (_url, { signal }) => {
    actualSignal = signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const pending = provider.stream({ messages: [{ role: 'user', content: 'test' }], signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(actualSignal.aborted, true);
});

test('provider validates endpoints and context bounds before sending credentials', async () => {
  for (const baseURL of ['http://provider.invalid/v1', 'https://key:secret@provider.invalid/v1', 'https://provider.invalid/v1?key=abc']) {
    assert.throws(() => createChatProvider({ ...settings, baseURL }), TypeError);
  }
  let fetched = false;
  const provider = createChatProvider({ ...settings, maxRequestBytes: 1024, fetcher: () => { fetched = true; } });
  await assert.rejects(provider.stream({ messages: [{ role: 'user', content: 'x'.repeat(2048) }] }), { code: 'REQUEST_LIMIT' });
  assert.equal(fetched, false);
  assert.deepEqual(AI_PROVIDER_CANDIDATES.slice(0, 3).map(provider => provider.id), ['openai', 'anthropic', 'google']);
  assert.equal(AI_PROVIDER_CANDIDATES.at(-1).id, 'other');
});

test('prepare/reject is read-only; accept uses one recoverable batch and cannot be replayed', async () => {
  const { directory, review, applied } = fixture();
  const proposal = { summary: 'Update the Joomla page', changes: [
    { operation: 'write', path: '/index.php', content: '<?php echo "after";\r\n' },
    { operation: 'mkdir', path: '/docs' }, { operation: 'write', path: '/docs/note.txt', content: 'note' },
  ] };
  const rejected = await review.prepare(proposal);
  assert.equal(fs.readFileSync(path.join(directory, 'index.php'), 'utf8'), '<?php echo "before";\r\n');
  review.reject(rejected.id);
  await assert.rejects(review.accept(rejected.id), /resolved/);
  assert.equal(applied(), 0);
  const prepared = await review.prepare(proposal);
  assert.equal(prepared.operations[0].before, '<?php echo "before";\r\n');
  const result = await review.accept(prepared.id);
  assert.equal(result.status, 'applied'); assert.ok(result.recoveryId); assert.equal(applied(), 1);
  assert.equal(fs.readFileSync(path.join(directory, 'docs/note.txt'), 'utf8'), 'note');
  await assert.rejects(review.accept(prepared.id), /resolved/);
  assert.equal((await review.undo(prepared.id)).status, 'recovered');
  assert.equal(fs.existsSync(path.join(directory, 'docs')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'index.php'), 'utf8'), '<?php echo "before";\r\n');
  assert.equal(applied(), 2);
});

test('AI edits preserve existing UTF-8 BOM and uniform line endings in review, apply and recovery', async () => {
  const { directory, review } = fixture();
  const cases = [
    { name: 'bom-crlf', before: '\ufeff<?php\r\necho "before";\r\n', proposed: '<?php\necho "after";\n', after: '\ufeff<?php\r\necho "after";\r\n' },
    { name: 'plain-lf', before: '<?php\necho "before";\n', proposed: '\ufeff<?php\r\necho "after";\r\n', after: '<?php\necho "after";\n' },
    { name: 'plain-cr', before: 'first\rsecond\r', proposed: 'first\nchanged\n', after: 'first\rchanged\r' },
  ];
  for (const item of cases) {
    const filename = path.join(directory, `${item.name}.txt`);
    const before = Buffer.from(item.before, 'utf8');
    fs.writeFileSync(filename, before);
    const prepared = await review.prepare({ summary: 'Change text without changing file format', changes: [
      { operation: 'write', path: `/${item.name}.txt`, content: item.proposed },
    ] });
    const operation = prepared.operations[0];
    assert.equal(operation.before, item.before, item.name);
    assert.equal(operation.after, item.after, item.name);
    assert.equal(operation.bytes, Buffer.byteLength(item.after, 'utf8'));
    assert.deepEqual(fs.readFileSync(filename), before, 'preparation is read-only');
    assert.equal((await review.accept(prepared.id)).status, 'applied');
    assert.deepEqual(fs.readFileSync(filename), Buffer.from(operation.after, 'utf8'), 'review describes the exact applied bytes');
    assert.equal((await review.undo(prepared.id)).status, 'recovered');
    assert.deepEqual(fs.readFileSync(filename), before, 'recovery restores the exact original format and contents');
  }
});

test('AI creates preserve provided format and existing mixed line endings require deliberate normalization', async () => {
  const { directory, review } = fixture();
  const content = '\ufefffirst\r\nsecond\nthird\r';
  const created = await review.prepare({ summary: 'Create a text file', changes: [
    { operation: 'write', path: '/new.txt', content },
  ] });
  assert.equal(created.operations[0].after, content);
  await review.accept(created.id);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'new.txt')), Buffer.from(content, 'utf8'));
  await assert.rejects(review.prepare({ summary: 'Rewrite mixed line endings', changes: [
    { operation: 'write', path: '/new.txt', content: 'first\nchanged\nthird\n' },
  ] }), /mixed line endings.*editor.*save.*again/i);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'new.txt')), Buffer.from(content, 'utf8'));
});

test('AI review refuses unsupported file encodings and malformed proposed Unicode without writes', async () => {
  const { directory, review } = fixture();
  const filename = path.join(directory, 'legacy.txt');
  const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
  fs.writeFileSync(filename, bytes);
  await assert.rejects(review.prepare({ summary: 'Rewrite unsupported text', changes: [
    { operation: 'write', path: '/legacy.txt', content: 'replacement' },
  ] }), /unsupported encoding/);
  assert.deepEqual(fs.readFileSync(filename), bytes);
  await assert.rejects(review.prepare({ summary: 'Create malformed text', changes: [
    { operation: 'write', path: '/malformed.txt', content: 'unpaired surrogate: \ud800' },
  ] }), /valid Unicode/);
  assert.equal(fs.existsSync(path.join(directory, 'malformed.txt')), false);
});

test('disk, dirty-buffer and folder membership conflicts prevent all AI writes', async () => {
  let dirty = false;
  const { directory, review } = fixture({ dirty: () => dirty });
  const first = await review.prepare({ summary: 'Update', changes: [{ operation: 'write', path: '/index.php', content: 'after' }] });
  dirty = true;
  await assert.rejects(review.accept(first.id), /Unsaved/);
  dirty = false;
  fs.writeFileSync(path.join(directory, 'index.php'), 'external');
  await assert.rejects(review.accept(first.id), { code: 'CONFLICT' });
  assert.equal(fs.readFileSync(path.join(directory, 'index.php'), 'utf8'), 'external');
  const deletion = await review.prepare({ summary: 'Remove old template', changes: [
    { operation: 'write', path: '/new.txt', content: 'first write' }, { operation: 'delete', path: '/templates' },
  ] });
  assert.equal(deletion.operations[1].entries[0].path, '/templates/site.css');
  fs.writeFileSync(path.join(directory, 'templates/new.txt'), 'unreviewed');
  await assert.rejects(review.accept(deletion.id), { code: 'CONFLICT' });
  assert.equal(fs.existsSync(path.join(directory, 'new.txt')), false);
});

test('partial AI apply reports failure, prevents blind retry and recovers completed writes', async () => {
  const { directory, review } = fixture({ overrides: { writeFile(filename, bytes) {
    fs.writeFileSync(filename, bytes);
    if (filename.endsWith('/failed.txt')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  } } });
  const prepared = await review.prepare({ summary: 'Add files', changes: [
    { operation: 'write', path: '/saved.txt', content: 'saved' },
    { operation: 'write', path: '/failed.txt', content: 'partial' },
    { operation: 'write', path: '/unwritten.txt', content: 'never' },
  ] });
  const result = await review.accept(prepared.id);
  assert.equal(result.status, 'partial'); assert.equal(result.result.failed.index, 1);
  assert.equal(fs.existsSync(path.join(directory, 'unwritten.txt')), false);
  await assert.rejects(review.accept(prepared.id), /resolved/);
  await review.undo(prepared.id);
  assert.equal(fs.existsSync(path.join(directory, 'saved.txt')), false);
  assert.equal(fs.existsSync(path.join(directory, 'failed.txt')), false);
});

test('AI tools exclude sensitive automatic context, enforce bounds and have no accept or shell tool', async () => {
  const { directory, review, workspace } = fixture();
  let selected = [];
  const tools = createAiWorkspaceTools({ workspace, review, selectedPaths: () => selected });
  const listing = await tools.execute('list_files', { path: '/' });
  assert.equal(listing.entries.some(item => isSensitiveAiPath(item.path)), false);
  await assert.rejects(tools.execute('read_file', { path: '/configuration.php' }), /Explicitly select/);
  const found = await tools.execute('search_files', { path: '/', query: 'secret' });
  assert.deepEqual(found.matches, []);
  selected = ['/configuration.php'];
  assert.match((await tools.execute('read_file', { path: '/configuration.php' })).content, /password/);
  const context = await tools.context({ openFiles: [{ path: '/index.php', canonicalPath: '/index.php', content: 'unsaved editor text', unsaved: true }, '/.env'] });
  assert.equal(context.files.find(file => file.path === '/index.php').unsaved, true);
  assert.equal(context.files.some(file => file.path === '/.env'), false);
  assert.equal(context.excluded[0].path, '/.env');
  assert.equal(context.files.some(file => file.path === '/configuration.php'), true);
  fs.writeFileSync(path.join(directory, 'index.php'), 'const API_KEY = "embedded-secret-token";');
  await assert.rejects(tools.execute('read_file', { path: '/index.php' }), /Explicitly select/);
  selected = ['/index.php'];
  assert.match((await tools.execute('read_file', { path: '/index.php' })).content, /embedded-secret-token/);
  assert.equal(tools.definitions.some(item => /accept|shell/.test(item.function.name)), false);
  await assert.rejects(tools.execute('accept', { path: '/index.php' }), /unsupported/);
  await assert.rejects(tools.execute('read_file', { path: '/../private' }), /traversal/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tools.execute('search_files', { path: '/', query: 'echo' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('AI guards canonical sources, alias directories and buffered text before sending context', async () => {
  const { directory, workspace, review } = fixture();
  const secret = '<?php public $secret = "canonical-source-regression";';
  fs.writeFileSync(path.join(directory, 'configuration.php'), secret);
  fs.symlinkSync('configuration.php', path.join(directory, 'readme.php'));
  fs.mkdirSync(path.join(directory, '.ssh'));
  fs.writeFileSync(path.join(directory, '.ssh/config'), 'Host private-system');
  fs.symlinkSync('.ssh', path.join(directory, 'public-docs'));
  let selected = [];
  const tools = createAiWorkspaceTools({ workspace, review, selectedPaths: () => selected });
  await assert.rejects(tools.execute('read_file', { path: '/readme.php' }), /canonical workspace path/);
  await assert.rejects(tools.execute('list_files', { path: '/public-docs' }), /canonical workspace path/);
  const listing = await tools.execute('list_files', { path: '/' });
  assert.equal(listing.entries.some(entry => ['readme.php', 'public-docs'].includes(entry.name)), false);
  assert.deepEqual((await tools.execute('search_files', { path: '/', query: 'canonical-source' })).matches, []);
  const buffer = { path: '/readme.php', canonicalPath: '/configuration.php', content: secret, unsaved: true };
  assert.deepEqual((await tools.context({ openFiles: [buffer] })).files, []);
  await assert.rejects(tools.context({ selection: { ...buffer, text: secret } }), /canonical workspace path/);
  await assert.rejects(tools.execute('propose_changes', { summary: 'Create file', changes: [
    { operation: 'write', path: '/public-docs/new.txt', content: 'new' },
  ] }), /canonical workspace path/);
  selected = ['/readme.php'];
  await assert.rejects(tools.execute('read_file', { path: '/readme.php' }), /canonical workspace path/);
  selected = ['/configuration.php'];
  assert.equal((await tools.execute('read_file', { path: '/readme.php' })).content, secret);
  assert.ok((await tools.context({ openFiles: [buffer] })).files.some(file => file.path === '/readme.php'));
  // Changing the link later must not relabel an old secret-bearing buffer as a
  // harmless public file, even when the current target itself is allowed.
  fs.unlinkSync(path.join(directory, 'readme.php'));
  fs.symlinkSync('index.php', path.join(directory, 'readme.php'));
  const moved = await tools.context({ openFiles: [buffer] });
  assert.equal(moved.files.some(file => file.path === '/readme.php'), false);
  assert.match(moved.excluded.find(file => file.path === '/readme.php').reason, /different file target/);
  await assert.rejects(tools.context({ selection: { ...buffer, text: secret } }), /different file target/);
  const unknown = await tools.context({ openFiles: [{ path: '/index.php', content: secret, unsaved: true }] });
  assert.equal(unknown.files.some(file => file.path === '/index.php'), false);
  // Revalidate the read response too: PHP can change an alias between the
  // metadata request and the separate read operation in the owner queue.
  selected = [];
  const request = workspace.request;
  workspace.request = (operation, args) => {
    if (operation === 'read' && args.path === '/readme.php') {
      fs.unlinkSync(path.join(directory, 'readme.php'));
      fs.symlinkSync('configuration.php', path.join(directory, 'readme.php'));
    }
    return request(operation, args);
  };
  await assert.rejects(tools.execute('read_file', { path: '/readme.php' }), /canonical workspace path/);
});

test('AI applies only the canonical targets shown when a proposal was prepared', async () => {
  const { directory, review } = fixture();
  fs.mkdirSync(path.join(directory, 'other'));
  fs.copyFileSync(path.join(directory, 'templates/site.css'), path.join(directory, 'other/site.css'));
  fs.symlinkSync('templates', path.join(directory, 'alias'));
  const prepared = await review.prepare({ summary: 'Update aliased template', changes: [
    { operation: 'write', path: '/alias/new.txt', content: 'new' },
    { operation: 'write', path: '/alias/site.css', content: 'reviewed update' },
  ] });
  fs.unlinkSync(path.join(directory, 'alias'));
  fs.symlinkSync('other', path.join(directory, 'alias'));
  await assert.rejects(review.accept(prepared.id), { code: 'CONFLICT' });
  assert.equal(fs.existsSync(path.join(directory, 'other/new.txt')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'other/site.css'), 'utf8'), 'body { color: red; }');
});

test('AI accept and recovery recheck dirty buffers after obtaining the owner write reservation', async () => {
  let dirty = false, gate = Promise.resolve(), release;
  const { directory, review } = fixture({ dirty: () => dirty, reserve: async callback => { await gate; return callback(); } });
  const prepared = await review.prepare({ summary: 'Update', changes: [{ operation: 'write', path: '/index.php', content: 'AI version' }] });
  gate = new Promise(resolve => { release = resolve; });
  const applying = review.accept(prepared.id);
  // The user keeps editing while a paused PHP request holds the mutation queue.
  dirty = true;
  assert.throws(() => review.reject(prepared.id), /still being applied/);
  release();
  await assert.rejects(applying, /Unsaved/);
  assert.equal(fs.readFileSync(path.join(directory, 'index.php'), 'utf8'), '<?php echo "before";\r\n');
  dirty = false;
  await review.accept(prepared.id);
  gate = new Promise(resolve => { release = resolve; });
  const recovering = review.undo(prepared.id);
  dirty = true; release();
  await assert.rejects(recovering, /Unsaved/);
  assert.equal(fs.readFileSync(path.join(directory, 'index.php'), 'utf8'), 'AI version');
  dirty = false;
  assert.equal((await review.undo(prepared.id)).status, 'recovered');
});

test('AI review cannot mutate through a workspace without the authoritative write reservation', () => {
  assert.throws(() => createAiReview({ workspace: { request() {} } }), /write reservation/);
});

test('current-file scope fences reads, search, aliases and mutation proposals while preserving unsaved text', async () => {
  const { directory, workspace, review } = fixture();
  fs.symlinkSync('templates/site.css', path.join(directory, 'alias.css'));
  const tools = createAiWorkspaceTools({ workspace, review, scope: { mode: 'current' } });
  const context = await tools.context({ scope: { mode: 'current' }, activePath: '/index.php', openFiles: [
    { path: '/index.php', canonicalPath: '/index.php', content: 'unsaved permitted context', unsaved: true },
    { path: '/templates/site.css', canonicalPath: '/templates/site.css', content: 'unrelated buffer', unsaved: true },
  ] });
  assert.deepEqual(context.files.map(file => file.path), ['/index.php']);
  assert.equal(context.files[0].unsaved, true);
  assert.equal((await tools.execute('read_file', { path: '/index.php' })).content, 'unsaved permitted context');
  await assert.rejects(tools.execute('read_file', { path: '/templates/site.css' }), /outside the selected/);
  await assert.rejects(tools.execute('read_file', { path: '/alias.css' }), /outside the selected/);
  await assert.rejects(tools.execute('propose_changes', { summary: 'escape scope', changes: [{ operation: 'write', path: '/outside.php', content: 'no' }] }), /outside the selected/);
  assert.deepEqual((await tools.execute('search_files', { path: '/', query: 'unrelated' })).matches, []);
  assert.deepEqual((await tools.execute('list_files', { path: '/' })).entries.map(file => file.path), ['/index.php']);
});

test('selected folders resolve recursively, enforce exclusions and never grant sensitive children implicitly', async () => {
  const { directory, workspace, review } = fixture();
  fs.mkdirSync(path.join(directory, 'templates/nested'));
  fs.writeFileSync(path.join(directory, 'templates/nested/view.php'), 'template body');
  fs.writeFileSync(path.join(directory, 'templates/.env'), 'API_KEY="unsafe-secret-token"');
  const tools = createAiWorkspaceTools({ workspace, review, scope: { mode: 'selected' } });
  const context = await tools.context({ scope: { mode: 'selected', paths: ['/templates'], excluded: ['/templates/site.css'] } });
  assert.deepEqual(context.files.map(file => file.path), ['/templates/nested/view.php']);
  assert.ok(context.excluded.some(file => file.path === '/templates/.env'));
  await assert.rejects(tools.execute('read_file', { path: '/templates/.env' }), /Explicitly select/);
  await assert.rejects(tools.execute('read_file', { path: '/templates/site.css' }), /outside the selected/);
  assert.equal((await tools.browse({ path: '/templates' })).entries.find(file => file.path === '/templates/.env').sensitive, true);
  const explicit = await tools.context({ scope: { mode: 'selected', paths: ['/templates/.env'] } });
  assert.equal(explicit.files[0].path, '/templates/.env');
});

test('project scope retrieves bounded context without recursively uploading the installation', async () => {
  const { workspace, review } = fixture();
  const tools = createAiWorkspaceTools({ workspace, review, scope: { mode: 'project' } });
  const context = await tools.context({ scope: { mode: 'project', paths: ['/templates'] }, openFiles: ['/index.php'] });
  assert.deepEqual(context.files.map(file => file.path), ['/index.php']);
  assert.equal((await tools.execute('read_file', { path: '/templates/site.css' })).path, '/templates/site.css');
  await assert.rejects(tools.execute('read_file', { path: '/configuration.php' }), /Explicitly select/);
});

test('separate assistant views cannot widen another conversation scope', async () => {
  const { workspace, review } = fixture();
  const embedded = createAiWorkspaceTools({ workspace, review, scope: { mode: 'current' } });
  const detached = createAiWorkspaceTools({ workspace, review, scope: { mode: 'project' } });
  await embedded.context({ scope: { mode: 'current' }, activePath: '/index.php', openFiles: ['/index.php'] });
  await detached.context({ scope: { mode: 'project' } });
  assert.equal((await detached.execute('read_file', { path: '/templates/site.css' })).path, '/templates/site.css');
  await assert.rejects(embedded.execute('read_file', { path: '/templates/site.css' }), /outside the selected/);
});

test('context budget includes selected text as well as file contents', async () => {
  const { workspace, review } = fixture();
  const tools = createAiWorkspaceTools({ workspace, review, scope: { mode: 'current' } });
  const content = 'editor text', text = 'text';
  const context = await tools.context({ scope: { mode: 'current' }, activePath: '/index.php',
    openFiles: [{ path: '/index.php', canonicalPath: '/index.php', content }],
    selection: { path: '/index.php', canonicalPath: '/index.php', text } });
  assert.equal(context.bytes, new TextEncoder().encode(content + text).byteLength);
});

test('review identifiers never resolve a stale transcript to a new service proposal', async () => {
  const { workspace, review, directory } = fixture();
  const old = await review.prepare({ summary: 'Old review', changes: [{ operation: 'write', path: '/index.php', content: 'old' }] });
  const replacement = createAiReview({ workspace });
  const current = await replacement.prepare({ summary: 'New review', changes: [{ operation: 'write', path: '/index.php', content: 'new' }] });
  assert.notEqual(old.id, current.id);
  await assert.rejects(replacement.accept(old.id), /expired/);
  assert.match(fs.readFileSync(path.join(directory, 'index.php'), 'utf8'), /before/);
  assert.equal(replacement.get(current.id).status, 'pending');
});

test('context and subsequent tools share a bounded byte budget without charging repeated reads twice', async () => {
  const { workspace, review, directory } = fixture();
  fs.writeFileSync(path.join(directory, 'index.php'), '1234567890');
  fs.writeFileSync(path.join(directory, 'templates/site.css'), 'abcdefghij');
  const tools = createAiWorkspaceTools({ workspace, review, maxContextBytes: 16, scope: { mode: 'project' } });
  const context = await tools.context({ scope: { mode: 'project' }, openFiles: ['/index.php'] });
  assert.equal(context.bytes, 10);
  assert.equal((await tools.execute('read_file', { path: '/index.php' })).budget.bytes, 10);
  await assert.rejects(tools.execute('read_file', { path: '/templates/site.css' }), /budget/);
  const result = await tools.execute('search_files', { path: '/', query: 'abcd' });
  assert.deepEqual(result.matches, []);
  assert.equal(result.budget.bytes, 10);
  assert.ok(result.skipped > 0);
  await tools.context({ scope: { mode: 'project' } });
  assert.equal((await tools.execute('read_file', { path: '/templates/site.css' })).budget.bytes, 10, 'the next request starts with a fresh budget');
});

test('cancellation stops recursive context and proposal preparation before a review becomes available', async () => {
  const { workspace, review } = fixture();
  const contextController = new AbortController();
  let lists = 0;
  const bounded = { ...workspace, async request(operation, args) {
    const result = await workspace.request(operation, args);
    if (operation === 'list' && ++lists === 1) contextController.abort();
    return result;
  } };
  const tools = createAiWorkspaceTools({ workspace: bounded, review, scope: { mode: 'selected' } });
  await assert.rejects(tools.context({ scope: { mode: 'selected', paths: ['/templates'] }, signal: contextController.signal }), { name: 'AbortError' });
  assert.equal(lists, 1);
  const proposalController = new AbortController();
  const cancellable = createAiReview({ workspace: { ...workspace, async request(operation, args) {
    const result = await workspace.request(operation, args);
    if (operation === 'read') proposalController.abort();
    return result;
  } } });
  await assert.rejects(cancellable.prepare({ summary: 'Cancelled proposal', changes: [{ operation: 'write', path: '/index.php', content: 'cancel me' }] }, { signal: proposalController.signal }), { name: 'AbortError' });
  const next = await cancellable.prepare({ summary: 'Fresh proposal', changes: [{ operation: 'write', path: '/index.php', content: 'fresh' }] });
  assert.match(next.id, /-1$/, 'cancelled preparation never publishes a review');
});
