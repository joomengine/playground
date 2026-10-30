import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createChatProvider, AI_PROVIDERS } from '../src/code/ai-provider.mjs';

const preset = id => AI_PROVIDERS.find(item => item.id === id);
const tool = { type: 'function', function: { name: 'read_file', description: 'Read one allowed file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } };
const messages = [{ role: 'system', content: 'Only use allowed tools.' }, { role: 'user', content: 'Inspect index.php' }];
const key = 'secret-that-must-not-appear-in-errors';
function sse(events, done = false) {
  const bytes = new TextEncoder().encode(events.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const openaiEvents = [
  { choices: [{ index: 0, delta: { content: 'Ready ✓', reasoning_content: 'provider continuation' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/index.php"}' } }] }, finish_reason: 'tool_calls' }] },
];
function fixture(id, options = {}) {
  const requests = [];
  const create = extra => createChatProvider({ provider: preset(id), apiKey: key, model: 'example-model', ...options,
    fetcher: async (url, init) => { requests.push({ url, ...init, parsed: init.body && JSON.parse(init.body) }); return extra(url, init); } });
  return { requests, create };
}

test('all named presets are ordered, internally configured and serialize as public data', () => {
  assert.deepEqual(AI_PROVIDERS.slice(0, 3).map(item => item.id), ['openai', 'anthropic', 'google']);
  assert.equal(AI_PROVIDERS.length, 23);
  assert.equal(AI_PROVIDERS.at(-1).id, 'other');
  assert.deepEqual([...new Set(AI_PROVIDERS.map(item => item.group))], ['providers', 'services', 'custom']);
  assert.equal(AI_PROVIDERS.find(item => item.group === 'services').id, 'groq');
  assert.equal(new Set(AI_PROVIDERS.map(item => item.id)).size, AI_PROVIDERS.length);
  for (const item of AI_PROVIDERS) assert.ok(item.baseURL || item.fields.length || item.id === 'other', item.id);
  assert.doesNotMatch(JSON.stringify(AI_PROVIDERS), /unverified|verification required|apiKey/);
});

test('factory works without imported bindings inside its serialized sandbox', async () => {
  const sandboxFactory = vm.runInNewContext(`(${createChatProvider.toString()})`, { URL, TextEncoder, TextDecoder, AbortController, DOMException, setTimeout, clearTimeout });
  const provider = sandboxFactory({ baseURL: 'http://localhost:11434/v1', model: 'local', apiKey: '', fetcher: async () => sse(openaiEvents, true) });
  const result = await provider.stream({ messages, tools: [tool] });
  assert.equal(result.content, 'Ready ✓');
  assert.equal(result.tool_calls[0].function.name, 'read_file');
});

test('Other accepts local optional authentication without downgrading named-provider endpoints', async () => {
  for (const baseURL of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:11434/v1', 'http://192.168.1.4:8080/v1', 'https://ai.example.com/v1']) {
    let sent;
    const provider = createChatProvider({ provider: preset('other'), baseURL, model: 'local', fetcher: async (url, init) => { sent = { url, ...init }; return sse(openaiEvents, true); } });
    await provider.stream({ messages });
    assert.equal(sent.headers.Authorization, undefined);
    assert.equal(sent.url, `${baseURL}/chat/completions`);
  }
  for (const baseURL of ['http://public.example/v1', 'https://key:secret@example.com', 'https://example.com/v1?key=abc', 'https://example.com/v1/chat/completions']) {
    assert.throws(() => createChatProvider({ baseURL, model: 'local' }), TypeError);
  }
  const { requests, create } = fixture('deepseek', { baseURL: 'http://localhost:8080' });
  await create(() => sse(openaiEvents, true)).stream({ messages });
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
});

test('Anthropic native streaming preserves tool inputs, thinking signatures and tool-result history', async () => {
  const { requests, create } = fixture('anthropic');
  const provider = create(() => sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'continuation' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ✓' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_native', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"/index.php"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ]));
  const result = await provider.stream({ messages, tools: [tool] });
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].headers['x-api-key'], key);
  assert.equal(requests[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(requests[0].headers['anthropic-version'], '2026-10-21');
  assert.equal(requests[0].parsed.tools[0].input_schema.type, 'object');
  assert.equal(result.content, 'Reading ✓');
  assert.equal(result._anthropic[0].signature, 'signed');
  await provider.stream({ messages: [...messages, result, { role: 'tool', tool_call_id: 'call_native', content: 'file result' }], tools: [tool] });
  assert.equal(requests[1].parsed.messages.at(-1).content[0].tool_use_id, 'call_native');
  assert.equal(requests[1].parsed.messages.at(-2).content[0].signature, 'signed');
  assert.deepEqual(requests[1].parsed.messages.at(-2).content[2].input, { path: '/index.php' });
});

test('Gemini preserves native function IDs and thought signatures on the following tool round', async () => {
  const { requests, create } = fixture('google', { model: 'models/gemini-example' });
  const provider = create(() => sse([
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Reading' }] } }] },
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'native-id', name: 'read_file', args: { path: '/index.php' } }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }] },
  ]));
  const result = await provider.stream({ messages, tools: [tool] });
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-example:streamGenerateContent?alt=sse');
  assert.equal(requests[0].headers['x-goog-api-key'], key);
  assert.equal(result.tool_calls[0].id, 'native-id');
  await provider.stream({ messages: [...messages, result, { role: 'tool', tool_call_id: 'native-id', content: 'result' }], tools: [tool] });
  assert.equal(requests[1].parsed.contents.at(-2).parts[1].thoughtSignature, 'opaque-signature');
  assert.equal(requests[1].parsed.contents.at(-1).parts[0].functionResponse.id, 'native-id');
  assert.equal(requests[1].parsed.contents.at(-1).parts[0].functionResponse.name, 'read_file');
});

test('Cohere uses native v2 chat event shapes and converts tool-result content', async () => {
  const { requests, create } = fixture('cohere');
  const provider = create(() => sse([
    { type: 'content-delta', delta: { message: { content: { text: 'Read' } } } },
    { type: 'tool-plan-delta', delta: { message: { tool_plan: 'Read selected context.' } } },
    { type: 'tool-call-start', index: 0, delta: { message: { tool_calls: { id: 'cohere-call', type: 'function', function: { name: 'read_file', arguments: '' } } } } },
    { type: 'tool-call-delta', index: 0, delta: { message: { tool_calls: { function: { arguments: '{"path":"/index.php"}' } } } } },
    { type: 'message-end', delta: { finish_reason: 'TOOL_CALL' } },
  ]));
  const result = await provider.stream({ messages, tools: [tool] });
  assert.equal(requests[0].url, 'https://api.cohere.com/v2/chat');
  assert.equal(requests[0].parsed.tool_choice, undefined);
  assert.equal(result.tool_plan, 'Read selected context.');
  assert.equal(result.tool_calls[0].function.name, 'read_file');
  await provider.stream({ messages: [...messages, result, { role: 'tool', tool_call_id: 'cohere-call', content: 'result' }], tools: [tool] });
  assert.deepEqual(requests[1].parsed.messages.at(-1).content, [{ type: 'text', text: 'result' }]);
});

for (const [id, path] of [['openai', '/v1/responses'], ['perplexity', '/v1/agent']]) {
  test(`${id} Responses-style adapter preserves complete output items and function-call replay`, async () => {
    const { requests, create } = fixture(id);
    const reasoning = { type: 'reasoning', id: 'reasoning_1', encrypted_content: 'continuation-data', summary: [] };
    const item = { type: 'function_call', call_id: 'response-call', id: 'fc_1', name: 'read_file', arguments: '{"path":"/index.php"}', status: 'completed' };
    const provider = create(() => sse([
      { type: 'response.output_item.added', output_index: 0, item: reasoning },
      { type: 'response.output_text.delta', delta: 'Reading' },
      { type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"/index.php"}' },
      { type: 'response.output_item.done', output_index: 1, item },
      { type: 'response.completed', response: { status: 'completed', output: [reasoning, item] } },
    ]));
    const result = await provider.stream({ messages, tools: [tool] });
    assert.equal(new URL(requests[0].url).pathname, path);
    assert.equal(requests[0].parsed.store, false);
    assert.equal(result.tool_calls[0].function.arguments, item.arguments);
    await provider.stream({ messages: [...messages, result, { role: 'tool', tool_call_id: 'response-call', content: 'result' }], tools: [tool] });
    assert.equal(requests[1].parsed.input.at(-1).type, 'function_call_output');
    assert.equal(requests[1].parsed.input.at(-1).call_id, 'response-call');
    assert.equal(requests[1].parsed.input.at(-3).encrypted_content, 'continuation-data');
  });
}

test('OpenAI-compatible providers retain required reasoning continuation without displaying it', async () => {
  const { requests, create } = fixture('minimax');
  const provider = create(() => sse(openaiEvents, true));
  let displayed = '';
  const result = await provider.stream({ messages, tools: [tool], onDelta: value => { displayed += value; } });
  assert.equal(result.reasoning_content, 'provider continuation');
  assert.equal(displayed, 'Ready ✓');
  await provider.stream({ messages: [...messages, result, { role: 'tool', tool_call_id: 'call_1', content: 'result' }], tools: [tool] });
  assert.equal(requests[1].parsed.messages.at(-2).reasoning_content, 'provider continuation');
});

test('native adapters reject truncated generation and preserve redacted failure/cancellation semantics', async () => {
  for (const id of ['anthropic', 'google', 'cohere', 'perplexity', 'openai']) {
    const provider = createChatProvider({ provider: preset(id), apiKey: key, model: 'model', fetcher: async () => sse([]) });
    await assert.rejects(provider.stream({ messages }), { code: 'INCOMPLETE_STREAM' });
    const failure = createChatProvider({ provider: preset(id), apiKey: key, model: 'model', fetcher: async () => new Response(key, { status: 403 }) });
    await assert.rejects(failure.stream({ messages }), error => error.code === 'HTTP_403' && !error.message.includes(key));
    const controller = new AbortController();
    const cancellable = createChatProvider({ provider: preset(id), apiKey: key, model: 'model', fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) });
    const pending = cancellable.stream({ messages, signal: controller.signal }); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  }
});

test('paginated model discovery uses each provider route, retains selection and filters non-tool models', async () => {
  const cases = [
    ['anthropic', {}, [{ data: [{ id: 'claude-opus-5' }], has_more: true, last_id: 'cursor' }, { data: [{ id: 'claude-sonnet-5' }], has_more: false }], '/v1/models', 'after_id=cursor', 'claude-sonnet-5'],
    ['google', {}, [{ models: [{ name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'cursor' }, { models: [{ name: 'models/gemini-4', supportedGenerationMethods: ['generateContent'] }] }], '/v1beta/models', 'pageToken=cursor', 'models/gemini-4'],
    ['cohere', {}, [{ models: [{ name: 'command-old', is_deprecated: true }], next_page_token: 'cursor' }, { models: [{ name: 'command-a', endpoints: ['chat'], features: ['tool_use'] }] }], '/v1/models', 'page_token=cursor', 'command-a'],
    ['qwen', { region: 'ap-southeast-1', workspaceId: 'work-123' }, [{ output: { total: 2, models: [{ model: 'embedding', capabilities: ['TR'] }] } }, { output: { total: 2, models: [{ model: 'qwen3-coder', capabilities: ['TG'], features: ['function-calling'] }] } }], '/api/v1/models', 'page_no=2', 'qwen3-coder'],
    ['fireworks', { accountId: 'my-account' }, [{ models: [{ name: 'accounts/my-account/models/unavailable', supportsServerless: false }], nextPageToken: 'cursor' }, { models: [{ name: 'accounts/my-account/models/code', supportsServerless: true, supportsTools: true }] }], '/v1/accounts/my-account/models', 'pageToken=cursor', 'accounts/my-account/models/code'],
  ];
  for (const [id, options, pages, pathname, pagination, expected] of cases) {
    const { requests, create } = fixture(id, options); let page = 0;
    const result = await create(() => json(pages[page++])).listModels({ currentModel: expected });
    assert.equal(requests.length, 2, id); assert.equal(new URL(requests[0].url).pathname, pathname, id);
    assert.ok(requests[1].url.includes(pagination), id); assert.deepEqual(result.models.map(item => item.id), id === 'anthropic' ? [expected, 'claude-opus-5'] : [expected], id);
    assert.equal(result.selectedModel, expected); assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].body, undefined);
  }
});

test('standard catalogs honor capabilities and model preferences instead of arbitrary first results', async () => {
  const provider = createChatProvider({ provider: preset('openrouter'), apiKey: key, fetcher: async () => json({ data: [
    { id: 'embedding', supported_parameters: [] }, { id: 'text-only', supported_parameters: ['temperature'] },
    { id: 'vendor/basic-chat', supported_parameters: ['tools'] }, { id: 'anthropic/claude-sonnet-5', supported_parameters: ['tools'] },
  ] }) });
  const initial = await provider.listModels(); assert.equal(initial.selectedModel, 'anthropic/claude-sonnet-5');
  const retained = await provider.listModels({ currentModel: 'vendor/basic-chat' }); assert.equal(retained.selectedModel, 'vendor/basic-chat');
  assert.equal(retained.models.length, 2);
});

test('regional endpoints separate inference and catalog routes; unavailable discovery never guesses /models', async () => {
  const { requests, create } = fixture('bedrock', { region: 'eu-west-1', route: 'mantle-openai' });
  const provider = create((_url, init) => init.method === 'GET' ? json({ data: [{ id: 'openai.gpt-oss-120b' }] }) : sse(openaiEvents, true));
  await provider.listModels(); await provider.stream({ messages });
  assert.equal(requests[0].url, 'https://bedrock-mantle.eu-west-1.api.aws/v1/models');
  assert.equal(requests[1].url, 'https://bedrock-mantle.eu-west-1.api.aws/openai/v1/chat/completions');
  for (const id of ['zai', 'nvidia', 'minimax', 'bedrock']) {
    let fetched = false;
    const result = await createChatProvider({ provider: preset(id), region: 'us-east-1', route: 'runtime', model: 'retained', fetcher: async () => { fetched = true; } }).listModels();
    assert.equal(fetched, false, id); assert.notEqual(result.source, 'live');
  }
  const azure = fixture('azure', { resource: 'my-resource' });
  await azure.create(() => sse(openaiEvents, true)).stream({ messages });
  assert.equal(azure.requests[0].url, 'https://my-resource.openai.azure.com/openai/v1/chat/completions');
  assert.equal(azure.requests[0].headers['api-key'], key); assert.equal(azure.requests[0].headers.Authorization, undefined);
});

test('catalog errors, cursor cycles, entry bounds and abort do not expose credentials', async () => {
  const errors = [
    [async () => new Response(key, { status: 401 }), 'HTTP_401'],
    [async () => json({ unexpected: key }), 'INVALID_CATALOG'],
    [async () => json({ data: [{ id: 'chat' }], has_more: true, last_id: 'same' }), 'INVALID_CATALOG'],
    [async () => { throw new Error(key); }, 'NETWORK_ERROR'],
  ];
  for (const [fetcher, code] of errors) {
    const provider = createChatProvider({ provider: preset('deepseek'), apiKey: key, fetcher });
    await assert.rejects(provider.listModels(), error => error.code === code && !error.message.includes(key));
  }
  const provider = createChatProvider({ provider: preset('deepseek'), apiKey: key, fetcher: async () => json({ data: [{ id: 'chat' }] }) });
  provider.dispose(); await assert.rejects(provider.listModels(), { code: 'CLOSED' });
});


test('unknown tool capability stays unknown and does not outrank a known capable model', async () => {
  const provider = createChatProvider({ provider: preset('other'), baseURL: 'http://localhost:11434/v1', fetcher: async () => json({ data: [
    { id: 'excellent-coder' }, { id: 'known-text', capabilities: { tools: { supported: false } } },
    { id: 'plain-model', capabilities: { tools: { supported: true } } },
    { id: 'no-stream', capabilities: { streaming: false } },
  ] }) });
  const result = await provider.listModels();
  assert.deepEqual(result.models.map(item => [item.id, item.tools]), [['plain-model', true], ['excellent-coder', null]]);
  assert.equal(result.selectedModel, 'plain-model');
});

test('compatible adapter does not forward a previous native Cohere tool_plan field', async () => {
  const { requests, create } = fixture('deepseek');
  const provider = create(() => sse(openaiEvents, true));
  await provider.stream({ messages: [...messages, { role: 'assistant', content: 'Earlier native output', tool_plan: 'Cohere metadata' }, { role: 'user', content: 'Continue' }] });
  assert.equal(requests[0].parsed.messages[2].tool_plan, undefined);
});

test('OpenRouter preserves the exact signed reasoning chunk sequence through a tool continuation', async () => {
  const details = [
    { type: 'reasoning.text', index: 0, id: 'reason-1', format: 'anthropic-claude-v1', text: 'Inspect ', signature: null },
    { type: 'reasoning.text', index: 0, id: 'reason-1', format: 'anthropic-claude-v1', text: 'the file.', signature: 'opaque-signature' },
    { type: 'reasoning.encrypted', index: 1, id: 'reason-2', data: 'opaque-encrypted-data', format: 'google-gemini-v1' },
  ];
  const { requests, create } = fixture('openrouter');
  let visible = '';
  const provider = create(() => sse([
    { choices: [{ index: 0, delta: { reasoning: 'Inspect ', reasoning_details: details.slice(0, 1) } }] },
    { choices: [{ index: 0, delta: { reasoning: 'the file.', reasoning_details: details.slice(1) } }] },
    ...openaiEvents,
  ], true));
  const result = await provider.stream({ messages, tools: [tool], onDelta: value => { visible += value; } });
  assert.equal(visible, 'Ready ✓');
  assert.equal(result.reasoning, 'Inspect the file.');
  assert.deepEqual(result.reasoning_details, details);
  await provider.stream({ messages: [...messages, result, { role: 'tool', tool_call_id: 'call_1', content: 'file result' }], tools: [tool] });
  assert.deepEqual(requests[1].parsed.messages.at(-2).reasoning_details, details);
  assert.equal(requests[1].parsed.messages.at(-2).reasoning, 'Inspect the file.');
  const invalid = create(() => sse([{ choices: [{ index: 0, delta: { reasoning_details: { invalid: true } }, finish_reason: 'stop' }] }], true));
  await assert.rejects(invalid.stream({ messages }), { code: 'INVALID_STREAM' });
});

const awsDiscovery = {
  region: 'us-east-1', route: 'runtime', accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  clock: () => new Date('2015-08-30T12:36:00Z'),
};
const foundationModel = (modelId, fields = {}) => ({ modelId, modelName: modelId,
  modelLifecycle: { status: 'ACTIVE' }, outputModalities: ['TEXT'], responseStreamingSupported: true,
  inferenceTypesSupported: ['ON_DEMAND'], ...fields });
const inferenceProfile = (inferenceProfileId, modelId, fields = {}) => ({ inferenceProfileId, inferenceProfileName: inferenceProfileId,
  status: 'ACTIVE', models: [{ modelArn: `arn:aws:bedrock:us-west-2::foundation-model/${modelId}` }], ...fields });

test('Bedrock native discovery signs with WebCrypto and matches independent curl SigV4 vectors', async () => {
  // Independently generated using curl --aws-sigv4 aws:amz:us-east-1:bedrock,
  // fixed x-amz-date/content-sha256 headers, and AWS's public example credentials.
  const vectors = [
    ['', '1c3e35e2e6ecd349046982e2b0aaf8b8db575209b48cf0f4ff08a8869328a356'],
    ['temporary+session/token=', 'db8f66c49e99e65da2cc96f4a8b1e551822d834e991497929dd0d480ecfff827'],
  ];
  for (const [sessionToken, signature] of vectors) {
    const { requests, create } = fixture('bedrock', { ...awsDiscovery, sessionToken });
    const provider = create((url, init) => init.method === 'POST' ? sse(openaiEvents, true)
      : json(new URL(url).pathname === '/foundation-models' ? { modelSummaries: [foundationModel('openai.gpt-oss-120b-1:0')] } : { inferenceProfileSummaries: [] }));
    const result = await provider.listModels({ currentModel: '' });
    assert.equal(result.source, 'live'); assert.equal(result.selectedModel, '');
    assert.equal(result.models[0].tools, null, 'native list cannot prove Chat or tool support');
    assert.equal(requests[0].url, 'https://bedrock.us-east-1.amazonaws.com/foundation-models?byOutputModality=TEXT');
    assert.equal(requests[0].headers.Authorization, `AWS4-HMAC-SHA256 Credential=${awsDiscovery.accessKeyId}/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date${sessionToken ? ';x-amz-security-token' : ''}, Signature=${signature}`);
    assert.equal(requests[0].headers['x-amz-security-token'], sessionToken || undefined);
    assert.equal(requests[0].headers.host, undefined);
    assert.equal(requests[0].headers['x-amz-date'], '20150830T123600Z');
    assert.equal(JSON.stringify(requests).includes(awsDiscovery.secretAccessKey), false);
    await provider.stream({ messages });
    assert.equal(requests.at(-1).headers.Authorization, `Bearer ${key}`);
    assert.equal(requests.at(-1).headers['x-amz-security-token'], undefined);
    assert.equal(requests.at(-1).url, 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/chat/completions');
  }
});

test('Bedrock native catalog joins active streaming models with paginated profiles without guessing compatibility', async () => {
  const { requests, create } = fixture('bedrock', { ...awsDiscovery, sessionToken: 'temporary+session/token=' });
  const provider = create(url => {
    const endpoint = new URL(url);
    if (endpoint.pathname === '/foundation-models') return json({ modelSummaries: [
      foundationModel('openai.gpt-oss-120b-1:0'), foundationModel('anthropic.profile-only', { inferenceTypesSupported: [] }),
      foundationModel('legacy', { modelLifecycle: { status: 'LEGACY' } }),
      foundationModel('no-stream', { responseStreamingSupported: false }),
      foundationModel('image', { outputModalities: ['IMAGE'] }),
    ] });
    if (!endpoint.searchParams.has('nextToken')) return json({ inferenceProfileSummaries: [
      inferenceProfile('us.anthropic.profile-only', 'anthropic.profile-only'),
      inferenceProfile('inactive', 'openai.gpt-oss-120b-1:0', { status: 'INACTIVE' }),
      inferenceProfile('invalid-target', 'image'), inferenceProfile('unknown-target', 'not-listed'),
    ], nextToken: 'a+b/c=' });
    return json({ inferenceProfileSummaries: [inferenceProfile('application-profile', 'openai.gpt-oss-120b-1:0')] });
  });
  const result = await provider.listModels({ currentModel: 'us.anthropic.profile-only' });
  assert.deepEqual(result.models.map(item => item.id).sort(), ['application-profile', 'openai.gpt-oss-120b-1:0', 'us.anthropic.profile-only']);
  assert.equal(result.selectedModel, 'us.anthropic.profile-only');
  assert.equal(requests[2].headers.Authorization.split('Signature=')[1], '03c3791674fa5075cd1bb3297de6bd79da9bcf4a9bfadc106555dfe245f9aeb7');
  assert.equal(new URL(requests[2].url).searchParams.get('nextToken'), 'a+b/c=');
  assert.ok(requests.every(request => request.method === 'GET' && request.body === undefined));
});

test('Bedrock discovery rejects partial credentials, redacts failures and cancels before signed fetch', async () => {
  let fetched = false;
  const partial = createChatProvider({ provider: preset('bedrock'), region: 'us-east-1', route: 'runtime', accessKeyId: awsDiscovery.accessKeyId,
    fetcher: async () => { fetched = true; } });
  await assert.rejects(partial.listModels(), { code: 'AWS_CREDENTIALS_REQUIRED' });
  assert.equal(fetched, false);
  const broken = createChatProvider({ provider: preset('bedrock'), ...awsDiscovery,
    fetcher: async () => { throw new Error(awsDiscovery.secretAccessKey); } });
  await assert.rejects(broken.listModels(), error => error.code === 'NETWORK_ERROR' && !error.message.includes(awsDiscovery.secretAccessKey));
  const cancelled = createChatProvider({ provider: preset('bedrock'), ...awsDiscovery, fetcher: async () => { fetched = true; } });
  const controller = new AbortController();
  const pending = cancelled.listModels({ signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(fetched, false);
  const cyclic = createChatProvider({ provider: preset('bedrock'), ...awsDiscovery, fetcher: async url => json(new URL(url).pathname === '/foundation-models'
    ? { modelSummaries: [] } : { inferenceProfileSummaries: [], nextToken: 'repeated' }) });
  await assert.rejects(cyclic.listModels(), { code: 'INVALID_CATALOG' });
});

test('Bedrock discovery remains self-contained when the factory is serialized in the secure sandbox', async () => {
  const factory = vm.runInNewContext(`(${createChatProvider.toString()})`, { crypto: globalThis.crypto, URL, TextEncoder, TextDecoder, AbortController, DOMException, setTimeout, clearTimeout });
  const provider = factory({ provider: preset('bedrock'), ...awsDiscovery, fetcher: async url => json(new URL(url).pathname === '/foundation-models'
    ? { modelSummaries: [foundationModel('example.chat')] } : { inferenceProfileSummaries: [] }) });
  const result = await provider.listModels();
  assert.equal(result.models[0].id, 'example.chat');
  assert.equal(result.selectedModel, '');
});

test('Other uses the selected native catalog and composes native versions without doubling the API base', async () => {
  for (const [protocol, suffix, catalogPath, catalog, terminal, chatPath, authHeader] of [
    ['anthropic', '/v1', '/v1/models', { data: [{ id: 'custom-chat' }] }, [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }], '/v1/messages', 'x-api-key'],
    ['cohere', '/v2', '/v1/models', { models: [{ name: 'custom-chat', endpoints: ['chat'] }] }, [{ type: 'message-end', delta: { finish_reason: 'COMPLETE' } }], '/v2/chat', 'Authorization'],
    ['gemini', '/v1beta', '/v1beta/models', { models: [{ name: 'models/custom-chat', supportedGenerationMethods: ['generateContent'] }] }, [{ candidates: [{ index: 0, finishReason: 'STOP' }] }], '/v1beta/models/custom-chat:streamGenerateContent', 'x-goog-api-key'],
  ]) {
    for (const basePath of protocol === 'gemini' ? [suffix] : ['', suffix]) {
      const requests = [];
      const provider = createChatProvider({ provider: preset('other'), baseURL: `https://private.example/gateway${basePath}`, protocol, model: 'custom-chat', apiKey: key,
        fetcher: async (url, init) => { requests.push({ url, ...init }); return init.method === 'GET' ? json(catalog) : sse(terminal); } });
      const result = await provider.listModels(); await provider.stream({ messages });
      assert.equal(result.models.length, 1, protocol);
      assert.equal(new URL(requests[0].url).pathname, `/gateway${catalogPath}`);
      assert.equal(new URL(requests[1].url).pathname, `/gateway${chatPath}`);
      assert.equal(requests[1].headers[authHeader], protocol === 'cohere' ? `Bearer ${key}` : key);
      assert.equal(requests[1].redirect, 'error');
    }
  }
});

test('catalog lifecycle filtering recognizes nested status without imposing Qwen capability vocabulary on other APIs', async () => {
  const provider = createChatProvider({ provider: preset('other'), baseURL: 'http://localhost:11434/v1', fetcher: async () => json({ data: [
    { id: 'local-coder', capabilities: ['completion', 'tools'] },
    { id: 'retired-chat', lifecycle: { status: 'retired' } },
    { id: 'inactive-chat', status: 'INACTIVE' },
    { id: 'legacy-status-chat', modelLifecycle: { status: 'DEPRECATED' } },
    { id: 'no-stream-chat', supports_streaming: false },
  ] }) });
  const result = await provider.listModels();
  assert.deepEqual(result.models.map(item => item.id), ['local-coder']);
  assert.equal(result.models[0].tools, null, 'unknown capability schema is not advertised as verified tool support');
  const malformed = createChatProvider({ provider: preset('other'), baseURL: 'http://localhost:11434/v1', fetcher: async () => json({ data: [null] }) });
  await assert.rejects(malformed.listModels(), { code: 'INVALID_CATALOG' });
});
