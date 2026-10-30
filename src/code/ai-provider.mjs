export { AI_PROVIDERS, AI_PROVIDER_CANDIDATES, AI_PROVIDER_MESSAGES } from './ai-provider-registry.mjs';

/**
 * A deliberately self-contained factory: the complete function is serialized into
 * the opaque-origin AI iframe. Neither credentials nor provider requests enter
 * the Joomla/owner realm. Registry entries contain public configuration only.
 */
export function createChatProvider({ provider = {}, baseURL, protocol = provider.protocol || 'openai',
  model = '', apiKey = '', region, workspaceId = '', resource = '', accountId = '', route,
  fetcher = globalThis.fetch, maxRequestBytes = 512 * 1024, maxResponseBytes = 2 * 1024 * 1024,
  timeoutMs = 120_000 } = {}) {
  const id = provider.id || 'other';
  if (id !== 'other') protocol = provider.protocol || 'openai';
  if (!['openai', 'anthropic', 'gemini', 'cohere', 'responses', 'agent'].includes(protocol)) throw new TypeError('Choose a supported AI API format.');
  const identifier = (value, label) => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(value)) throw new TypeError(`Enter a valid ${label}.`);
    return value;
  };
  if (id !== 'other' && provider.baseURL) baseURL = provider.baseURL;
  if (id === 'qwen') {
    region ||= 'ap-southeast-1';
    if (!['ap-southeast-1', 'cn-beijing', 'cn-hongkong', 'eu-central-1', 'ap-northeast-1', 'us-east-1'].includes(region)) throw new TypeError('Choose a supported Alibaba region.');
    baseURL = `https://${identifier(workspaceId, 'workspace ID')}.${region}.maas.aliyuncs.com/compatible-mode/v1`;
  } else if (id === 'azure') baseURL = `https://${identifier(resource, 'Azure resource name')}.openai.azure.com/openai/v1`;
  else if (id === 'bedrock') {
    region ||= 'us-east-1'; route ||= 'mantle';
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) || !['runtime', 'mantle', 'mantle-openai'].includes(route)) throw new TypeError('Choose a valid Bedrock region and endpoint.');
    baseURL = route === 'runtime' ? `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`
      : `https://bedrock-mantle.${region}.api.aws/${route === 'mantle-openai' ? 'openai/' : ''}v1`;
  }
  let base;
  try { base = new URL(baseURL); } catch { throw new TypeError('Enter the AI API base URL.'); }
  const local = /^(?:localhost|.*\.localhost|.*\.local|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|\[f[cd][0-9a-f:]+\]|\[fe80:[0-9a-f:]+\])$/i.test(base.hostname);
  if ((base.protocol !== 'https:' && !(id === 'other' && base.protocol === 'http:' && local))
    || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Use an HTTPS AI API base URL, or a local HTTP server, without credentials, query parameters or a fragment.');
  }
  base.pathname = base.pathname.replace(/\/+$/, '');
  // A common paste error must not silently produce /chat/completions/chat/completions.
  if (/\/(?:chat\/completions|responses|messages|models)$/.test(base.pathname)) throw new TypeError('Enter the API base URL, without the chat, messages, responses or models operation.');
  if (typeof model !== 'string' || model.length > 256 || /[\r\n]/.test(model)) throw new TypeError('Choose a provider model.');
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new TypeError('Enter a valid AI API key.');
  if (typeof fetcher !== 'function') throw new TypeError('Fetch is unavailable.');
  for (const [value, minimum, maximum] of [[maxRequestBytes, 1024, 2 ** 22], [maxResponseBytes, 1024, 2 ** 24], [timeoutMs, 1, 600_000]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError('Invalid provider limit.');
  }
  const encoder = new TextEncoder(), requests = new Set(), failures = new WeakSet();
  let disposed = false;
  const auth = provider.auth || (protocol === 'anthropic' ? 'anthropic' : protocol === 'gemini' ? 'google' : 'optional');
  function failure(message, code = 'PROVIDER_ERROR') { const error = new Error(message); error.code = code; failures.add(error); return error; }
  function url(path) { return new URL(`${base.href.replace(/\/$/, '')}/${path.replace(/^\//, '')}`); }
  function headers(accept) {
    if (id !== 'other' && !apiKey.trim() && !(id === 'perplexity' && accept === 'application/json')) throw failure('Enter your AI API key in the isolated settings panel.', 'KEY_REQUIRED');
    const result = { Accept: accept };
    if (apiKey.trim()) {
      if (auth === 'anthropic' || (id === 'other' && protocol === 'anthropic')) result['x-api-key'] = apiKey.trim();
      else if (auth === 'google' || (id === 'other' && protocol === 'gemini')) result['x-goog-api-key'] = apiKey.trim();
      else if (auth === 'azure') result['api-key'] = apiKey.trim();
      else result.Authorization = `Bearer ${apiKey.trim()}`;
    }
    if (protocol === 'anthropic') {
      result['anthropic-version'] = '2023-06-01';
      result['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    return result;
  }
  async function checkedFetch(endpoint, init) {
    const response = await fetcher(endpoint.href, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', ...init });
    if (!response.ok) {
      await response.body?.cancel();
      const advice = response.status === 401 || response.status === 403 ? 'Check the API key, region and account permissions.'
        : response.status === 429 ? 'The provider quota or rate limit was reached.'
          : response.status === 404 ? 'This API route or model is unavailable. Check the selected API format and model ID.'
            : 'The provider could not complete the request. Try again.';
      throw failure(`AI provider HTTP ${response.status}. ${advice}`, `HTTP_${response.status}`);
    }
    return response;
  }
  async function bounded(signal, operation) {
    if (disposed) throw failure('The AI provider session is closed.', 'CLOSED');
    signal?.throwIfAborted();
    const controller = new AbortController(), abort = () => controller.abort();
    requests.add(controller); signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try { return await operation(controller.signal); }
    catch (error) {
      if (timedOut) throw failure('The AI request timed out. Your project files were not changed.', 'TIMEOUT');
      if (controller.signal.aborted) throw new DOMException('AI request cancelled.', 'AbortError');
      if (failures.has(error)) throw error;
      throw failure(base.protocol === 'http:'
        ? 'Cannot reach the local AI API. Check that the server is running, permits this browser origin (including the isolated panel), and that local-network permission and mixed-content rules allow access.'
        : 'Cannot reach the AI API. Check the endpoint, network and server CORS policy. The isolated panel uses an opaque origin; the server must allow browser access.', 'NETWORK_ERROR');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); requests.delete(controller); }
  }
  async function jsonResponse(response) {
    if (!response.body) throw failure('The model catalog response was empty.', 'INVALID_CATALOG');
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) throw failure('The model catalog exceeded its size limit.', 'RESPONSE_LIMIT');
        text += decoder.decode(chunk.value, { stream: true }); }
      text += decoder.decode();
      try { return JSON.parse(text); } catch { throw failure('The API returned an invalid model catalog.', 'INVALID_CATALOG'); }
    } finally { try { await reader.cancel(); } catch { /* closed */ } reader.releaseLock(); }
  }
  function usable(item) {
    const id = item.id || item.name || item.model;
    if (typeof id !== 'string' || !id.trim() || id.length > 256) return null;
    if (item.active === false || item.archived === true || item.deprecated === true || item.is_deprecated === true || /retired|deprecated/i.test(item.status || item.lifecycle || '')) return null;
    if (/embed|rerank|whisper|tts|dall-e|moderation|imagen|veo|(^|[/-])audio|transcri|realtime|safety|guard/i.test(id)) return null;
    const methods = item.supportedGenerationMethods;
    if (Array.isArray(methods) && !methods.includes('generateContent')) return null;
    if (item.capabilities?.completion_chat === false || item.capabilities?.function_calling === false) return null;
    if (Array.isArray(item.supported_parameters) && !item.supported_parameters.includes('tools')) return null;
    if (Array.isArray(item.capabilities) && !item.capabilities.some(value => ['TG', 'Reasoning', 'text-generation'].includes(value))) return null;
    if (provider.catalog === 'qwen' && Array.isArray(item.features) && !item.features.includes('function-calling')) return null;
    if (Array.isArray(item.endpoints) && !item.endpoints.includes('chat')) return null;
    if (item.type && !['chat', 'model', 'language', 'text', 'text-generation'].includes(item.type) && !methods) return null;
    if (Array.isArray(item.architecture?.output_modalities) && !item.architecture.output_modalities.includes('text')) return null;
    if (Array.isArray(item.providers) && !item.providers.some(route => route.status === 'live' && route.supports_tools === true)) return null;
    if (item.supports_tools === false || item.supportsTools === false || item.tool_calling === false) return null;
    if (item.supportsServerless === false || item.supports_serverless === false) return null;
    if (provider.id === 'openai' && (!/^(gpt-|o[1-9])/.test(id) || /instruct|search|image|deep-research|computer-use/i.test(id))) return null;
    if (provider.catalog === 'fireworks' && item.supportsServerless !== true) return null;
    return { id, label: item.display_name || item.displayName || id,
      tools: item.providers?.some(route => route.status === 'live' && route.supports_tools === true) || item.capabilities?.function_calling === true || item.supports_tools === true || item.supportsTools === true || item.tool_calling === true
        || (Array.isArray(item.supported_parameters) && item.supported_parameters.includes('tools')) ? true : null };
  }
  async function listModels({ signal, currentModel = model } = {}) {
    const catalog = provider.catalog || (protocol === 'anthropic' ? 'anthropic' : protocol === 'gemini' ? 'gemini' : protocol === 'cohere' ? 'cohere' : 'openai');
    return bounded(signal, async active => {
      let source = 'live', items = [];
      if (catalog === 'static' || catalog === 'manual' || (id === 'bedrock' && route === 'runtime')) {
        source = catalog === 'static' ? 'catalog' : 'manual';
        items = (provider.models || []).map(id => ({ id }));
      } else {
        let endpoint = catalog === 'anthropic' ? url('v1/models') : catalog === 'cohere' ? url('v1/models?endpoint=chat')
          : catalog === 'agent' ? url('v1/models') : url('models');
        if (catalog === 'bedrock') endpoint = new URL(`https://bedrock-mantle.${region}.api.aws/v1/models`);
        if (catalog === 'qwen') {
          const host = region === 'ap-southeast-1' ? 'dashscope-intl.aliyuncs.com' : region === 'cn-hongkong' ? 'cn-hongkong.dashscope.aliyuncs.com' : `${workspaceId}.${region}.maas.aliyuncs.com`;
          endpoint = new URL(`https://${host}/api/v1/models?page_size=100&page_no=1&capabilities=TG&features=function-calling`);
        }
        if (catalog === 'fireworks') endpoint = new URL(`https://api.fireworks.ai/v1/accounts/${identifier(accountId, 'Fireworks account ID')}/models?pageSize=100`);
        const visited = new Set();
        for (let page = 0; page < 50; page++) {
          active.throwIfAborted();
          if (visited.has(endpoint.href)) throw failure('The model catalog repeated a pagination cursor.', 'INVALID_CATALOG');
          visited.add(endpoint.href);
          const data = await jsonResponse(await checkedFetch(endpoint, { method: 'GET', headers: headers('application/json'), signal: active }));
          const batch = Array.isArray(data) ? data : data.data || data.models || data.output?.models;
          if (!Array.isArray(batch)) throw failure('The API did not return a supported model catalog. Enter a model ID manually.', 'INVALID_CATALOG');
          items.push(...batch);
          if (items.length > 10000) throw failure('The model catalog exceeded its entry limit.', 'RESPONSE_LIMIT');
          let next = false;
          if (catalog === 'anthropic' && data.has_more && data.last_id) { endpoint.searchParams.set('after_id', data.last_id); next = true; }
          else if (data.nextPageToken) { endpoint.searchParams.set('pageToken', data.nextPageToken); next = true; }
          else if (data.next_page_token) { endpoint.searchParams.set('page_token', data.next_page_token); next = true; }
          else if (catalog === 'qwen' && items.length < data.output?.total) { endpoint.searchParams.set('page_no', String(page + 2)); next = true; }
          else if (data.has_more && (data.last_id || batch.at(-1)?.id)) { endpoint.searchParams.set('after', data.last_id || batch.at(-1).id); next = true; }
          if (!next && data.has_more) throw failure('The model catalog omitted its pagination cursor.', 'INVALID_CATALOG');
          if (!next) break;
          if (page === 49) throw failure('The model catalog has too many pages. Enter a model ID manually.', 'RESPONSE_LIMIT');
        }
      }
      const models = [...new Map(items.map(usable).filter(Boolean).map(item => [item.id, item])).values()];
      const preferences = provider.preferences || ['coder', 'code', 'instruct', 'chat'];
      const rank = item => { const index = preferences.findIndex(value => item.id.toLowerCase().includes(value.toLowerCase())); return index < 0 ? preferences.length : index; };
      models.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, 'en', { numeric: true }));
      return { models, selectedModel: models.some(item => item.id === currentModel) ? currentModel : (source === 'manual' ? currentModel : models[0]?.id || ''), source };
    });
  }
  function checkedMessages(messages, tools) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 128 || !Array.isArray(tools) || tools.length > 16) throw new TypeError('Invalid AI conversation.');
    for (const message of messages) {
      if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)
        || (typeof message.content !== 'string' && message.content !== null)) throw new TypeError('Only text conversation messages are supported.');
    }
  }
  function requestBody(messages, tools) {
    const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n');
    if (protocol === 'anthropic') {
      const turns = [];
      for (const message of messages.filter(item => item.role !== 'system')) {
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const content = message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]
          : message._anthropic || [...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...(message.tool_calls || []).map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }))];
        if (turns.at(-1)?.role === role) turns.at(-1).content.push(...content); else turns.push({ role, content });
      }
      return { model: model.trim(), system, messages: turns, max_tokens: 8192, stream: true,
        ...(tools.length ? { tools: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters })), tool_choice: { type: 'auto' } } : {}) };
    }
    if (protocol === 'gemini') {
      const contents = [], names = new Map();
      for (const message of messages.filter(item => item.role !== 'system')) {
        for (const call of message.tool_calls || []) names.set(call.id, call.function.name);
        const role = message.role === 'assistant' ? 'model' : 'user';
        const parts = message.role === 'tool' ? [{ functionResponse: { id: message.tool_call_id, name: names.get(message.tool_call_id), response: { result: message.content } } }]
          : message._gemini || [...(message.content ? [{ text: message.content }] : []),
            ...(message.tool_calls || []).map(call => ({ functionCall: { id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) } }))];
        if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts); else contents.push({ role, parts });
      }
      return { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map(({ function: fn }) => ({ name: fn.name, description: fn.description, parametersJsonSchema: fn.parameters })) }] } : {}) };
    }
    if (protocol === 'responses' || protocol === 'agent') {
      const input = [];
      for (const message of messages.filter(item => item.role !== 'system')) {
        if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
        else if (message._responses) input.push(...message._responses);
        else {
          if (message.content) input.push({ role: message.role, content: message.content });
          input.push(...(message.tool_calls || []).map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })));
        }
      }
      return { model: model.trim(), input, instructions: system, stream: true, store: false,
        ...(protocol === 'agent' ? { max_output_tokens: 8192 } : { include: ['reasoning.encrypted_content'] }),
        ...(tools.length ? { tools: tools.map(({ function: fn }) => ({ type: 'function', ...fn, strict: false })), tool_choice: 'auto' } : {}) };
    }
    const turns = messages.map(({ _anthropic, _gemini, _responses, ...message }) => message);
    if (protocol === 'cohere') for (const message of turns) {
      if (message.role === 'tool') message.content = [{ type: 'text', text: message.content }];
      if (message.role === 'assistant' && message.content == null) delete message.content;
      delete message.reasoning_content;
    }
    return { model: model.trim(), messages: turns, stream: true, ...(tools.length ? { tools, ...(protocol === 'cohere' ? {} : { tool_choice: 'auto' }) } : {}) };
  }
  async function stream({ messages, tools = [], signal, onDelta = () => {} } = {}) {
    if (disposed) throw failure('The AI provider session is closed.', 'CLOSED');
    if (!model.trim()) throw failure('Choose a model or enter its model ID.', 'MODEL_REQUIRED');
    checkedMessages(messages, tools);
    const request = JSON.stringify(requestBody(messages, tools));
    if (encoder.encode(request).byteLength > maxRequestBytes) throw failure('The AI request is too large. Remove context or start a new conversation.', 'REQUEST_LIMIT');
    const endpoint = protocol === 'anthropic' ? url('v1/messages') : protocol === 'cohere' ? url('v2/chat')
      : protocol === 'agent' ? url('v1/agent') : protocol === 'responses' ? url('responses')
        : protocol === 'gemini' ? url(`${model.startsWith('models/') ? '' : 'models/'}${model.trim()}:streamGenerateContent?alt=sse`) : url('chat/completions');
    return bounded(signal, async active => {
      const response = await checkedFetch(endpoint, { method: 'POST', headers: { ...headers('text/event-stream'), 'Content-Type': 'application/json' }, body: request, signal: active });
      if (!response.body || !/^text\/event-stream\b/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel(); throw failure('The endpoint did not return a supported event stream.', 'INVALID_STREAM');
      }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      const calls = new Map(), blocks = new Map(), geminiParts = [], responseItems = new Map();
      let buffer = '', data = [], content = '', reasoning = '', toolPlan = '', bytes = 0, done = false, finishReason = null;
      function append(value) { if (typeof value === 'string') { content += value; onDelta(value); } }
      function call(index, fragment, replace = false) {
        if (!Number.isInteger(index) || index < 0 || index >= 128) throw failure('Invalid streamed tool index.', 'TOOL_LIMIT');
        if (!calls.has(index) && calls.size >= 16) throw failure('Too many streamed tool calls.', 'TOOL_LIMIT');
        const value = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (fragment.id) { if (typeof fragment.id !== 'string' || fragment.id.length > 256) throw failure('Invalid tool identifier.', 'INVALID_STREAM'); value.id = fragment.id; }
        for (const key of ['name', 'arguments']) if (fragment.function?.[key] !== undefined) {
          if (typeof fragment.function[key] !== 'string') throw failure('Invalid tool delta.', 'INVALID_STREAM');
          value.function[key] = replace ? fragment.function[key] : value.function[key] + fragment.function[key];
        }
        if (value.function.name.length > 128) throw failure('Invalid tool name.', 'INVALID_STREAM');
        calls.set(index, value);
      }
      function event() {
        if (!data.length) return;
        const payload = data.join('\n'); data = [];
        if (payload === '[DONE]') { if (protocol === 'openai') done = true; return; }
        let value;
        try { value = JSON.parse(payload); } catch { throw failure('The provider sent an invalid stream event.', 'INVALID_STREAM'); }
        if (value.error || value.type === 'error' || ['response.failed', 'response.incomplete'].includes(value.type)) throw failure('The provider reported a failure during streaming. No proposed changes were applied.', 'STREAM_ERROR');
        if (protocol === 'anthropic') {
          if (value.type === 'content_block_start') {
            blocks.set(value.index, structuredClone(value.content_block));
            if (value.content_block.type === 'tool_use') call(value.index, { id: value.content_block.id, function: { name: value.content_block.name, arguments: '' } });
            if (value.content_block.type === 'text') append(value.content_block.text);
          } else if (value.type === 'content_block_delta') {
            const block = blocks.get(value.index), delta = value.delta;
            if (delta.type === 'text_delta') { append(delta.text); if (block) block.text += delta.text; }
            if (delta.type === 'input_json_delta') call(value.index, { function: { arguments: delta.partial_json } });
            if (block && delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
            if (block && delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
          } else if (value.type === 'message_delta') finishReason = value.delta.stop_reason === 'tool_use' ? 'tool_calls' : ['end_turn', 'stop_sequence'].includes(value.delta.stop_reason) ? 'stop' : value.delta.stop_reason;
          else if (value.type === 'message_stop') done = true;
          return;
        }
        if (protocol === 'gemini') {
          const candidate = value.candidates?.find(item => item.index === 0) || value.candidates?.[0];
          if (value.promptFeedback?.blockReason) throw failure('The provider blocked this request.', 'CONTENT_BLOCKED');
          for (const part of candidate?.content?.parts || []) {
            geminiParts.push(part);
            if (!part.thought) append(part.text);
            if (part.functionCall) { const fn = part.functionCall; const index = calls.size;
              call(index, { id: fn.id || `gemini_call_${index}`, function: { name: fn.name, arguments: JSON.stringify(fn.args || {}) } }); }
          }
          if (candidate?.finishReason) { finishReason = candidate.finishReason === 'STOP' ? (calls.size ? 'tool_calls' : 'stop') : candidate.finishReason; done = true; }
          return;
        }
        if (protocol === 'cohere') {
          if (value.type === 'content-delta') append(value.delta?.message?.content?.text);
          if (value.type === 'tool-plan-delta' && typeof value.delta?.message?.tool_plan === 'string') toolPlan += value.delta.message.tool_plan;
          if (value.type === 'tool-call-start' || value.type === 'tool-call-delta') call(value.index, value.delta?.message?.tool_calls || {});
          if (value.type === 'message-end') { finishReason = value.delta?.finish_reason === 'TOOL_CALL' ? 'tool_calls' : value.delta?.finish_reason === 'COMPLETE' ? (calls.size ? 'tool_calls' : 'stop') : value.delta?.finish_reason; done = true; }
          return;
        }
        if (protocol === 'responses' || protocol === 'agent') {
          if (value.type === 'response.output_text.delta') append(value.delta);
          if (value.type === 'response.output_item.added' || value.type === 'response.output_item.done') {
            responseItems.set(value.output_index, value.item);
            if (value.item?.type === 'function_call') call(value.output_index, { id: value.item.call_id, function: { name: value.item.name, arguments: value.item.arguments || '' } }, true);
          }
          if (value.type === 'response.function_call_arguments.delta') call(value.output_index, { function: { arguments: value.delta } });
          if (value.type === 'response.function_call_arguments.done') call(value.output_index, { function: { arguments: value.arguments } }, true);
          if (value.type === 'response.completed') {
            if (value.response?.status && value.response.status !== 'completed') throw failure('The provider did not complete the response.', 'INCOMPLETE_STREAM');
            if (Array.isArray(value.response?.output)) value.response.output.forEach((item, index) => {
              responseItems.set(index, item);
              if (item.type === 'function_call') call(index, { id: item.call_id, function: { name: item.name, arguments: item.arguments } }, true);
            });
            finishReason = calls.size ? 'tool_calls' : 'stop'; done = true;
          }
          return;
        }
        const choice = value.choices?.find(item => item.index === 0) || value.choices?.[0];
        if (!choice) return;
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
        append(choice.delta?.content);
        if (typeof choice.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content;
        if (choice.delta?.tool_calls !== undefined && !Array.isArray(choice.delta.tool_calls)) throw failure('Invalid streamed tool calls.', 'INVALID_STREAM');
        for (const fragment of choice.delta?.tool_calls || []) { if (fragment.type && fragment.type !== 'function') throw failure('Unsupported tool type.', 'INVALID_STREAM'); call(fragment.index, fragment); }
      }
      function line(value) { if (value === '') event(); else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, '')); }
      try {
        while (!done) {
          active.throwIfAborted(); const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength; if (bytes > maxResponseBytes) throw failure('The AI response exceeded its size limit. No changes were applied.', 'RESPONSE_LIMIT');
          buffer += decoder.decode(chunk.value, { stream: true });
          let position;
          while ((position = buffer.indexOf('\n')) !== -1 && !done) { line(buffer.slice(0, position).replace(/\r$/, '')); buffer = buffer.slice(position + 1); }
        }
        buffer += decoder.decode(); if (!done && buffer) line(buffer.replace(/\r$/, '')); if (!done) event();
        if (!done || !['stop', 'tool_calls'].includes(finishReason)) throw failure('The AI response ended before completion. Partial tool calls were discarded; try again.', 'INCOMPLETE_STREAM');
        if (protocol === 'anthropic') for (const [index, value] of calls) {
          if (!value.function.arguments) value.function.arguments = JSON.stringify(blocks.get(index)?.input || {});
        }
        const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value), identifiers = new Set();
        for (const value of toolCalls) {
          if (!value.id || !value.function.name || identifiers.has(value.id)) throw failure('Invalid completed tool call.', 'INVALID_STREAM'); identifiers.add(value.id);
          try { const args = JSON.parse(value.function.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
          catch { throw failure('The provider returned incomplete or invalid tool arguments.', 'INVALID_STREAM'); }
        }
        if (toolCalls.length && finishReason !== 'tool_calls') throw failure('The provider did not complete its tool calls.', 'INCOMPLETE_STREAM');
        if (protocol === 'anthropic') for (const [index, value] of calls) blocks.get(index).input = JSON.parse(value.function.arguments);
        return { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolPlan ? { tool_plan: toolPlan } : {}),
          ...(protocol === 'anthropic' ? { _anthropic: [...blocks.values()] } : {}),
          ...(protocol === 'gemini' ? { _gemini: geminiParts } : {}),
          ...(['responses', 'agent'].includes(protocol) ? { _responses: [...responseItems.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) } : {}) };
      } finally { try { await reader.cancel(); } catch { /* Already closed or aborted. */ } reader.releaseLock(); }
    });
  }
  return Object.freeze({ stream, listModels, dispose() { disposed = true; apiKey = ''; for (const request of requests) request.abort(); requests.clear(); } });
}
