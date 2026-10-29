/**
 * Small OpenAI-compatible streaming client. Keep this function self-contained:
 * the credential panel installs it inside an opaque-origin sandbox, never in
 * the executable Joomla document or its parent's credential-bearing state.
 */
export function createChatProvider({ baseURL, model, apiKey, fetcher = globalThis.fetch,
  maxRequestBytes = 512 * 1024, maxResponseBytes = 2 * 1024 * 1024, timeoutMs = 120_000 } = {}) {
  const endpoint = new URL(baseURL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('Use an HTTPS provider base URL without credentials, query parameters or a fragment.');
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/chat/completions`;
  if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new TypeError('Choose a provider model.');
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) {
    throw new TypeError('Enter an API key in the isolated AI panel.');
  }
  if (typeof fetcher !== 'function') throw new TypeError('Fetch is unavailable.');
  for (const [value, minimum, maximum] of [[maxRequestBytes, 1024, 2 ** 22], [maxResponseBytes, 1024, 2 ** 24], [timeoutMs, 1, 600_000]]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError('Invalid provider limit.');
  }
  const encoder = new TextEncoder();
  let disposed = false;
  const requests = new Set();
  const failures = new WeakSet();
  function failure(message, code = 'PROVIDER_ERROR') {
    const error = new Error(message);
    error.code = code;
    failures.add(error);
    return error;
  }
  async function stream({ messages, tools = [], signal, onDelta = () => {} } = {}) {
    if (disposed) throw failure('The AI provider session is closed.', 'CLOSED');
    if (!Array.isArray(messages) || !messages.length || messages.length > 128
      || !Array.isArray(tools) || tools.length > 16) throw new TypeError('Invalid AI conversation.');
    for (const message of messages) {
      if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)
        || (typeof message.content !== 'string' && message.content !== null)) throw new TypeError('Only text conversation messages are supported.');
    }
    const request = JSON.stringify({ model: model.trim(), messages, stream: true,
      ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) });
    if (encoder.encode(request).byteLength > maxRequestBytes) throw failure('The AI request is too large. Remove context or start a new conversation.', 'REQUEST_LIMIT');
    signal?.throwIfAborted();
    const controller = new AbortController();
    requests.add(controller);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let reader;
    try {
      const response = await fetcher(endpoint.href, {
        method: 'POST', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${apiKey.trim()}` },
        body: request, signal: controller.signal,
      });
      if (!response.ok) {
        // Provider bodies sometimes echo request parameters. Never forward them,
        // Authorization headers or a key-bearing Error.cause to the host frame.
        await response.body?.cancel();
        const advice = response.status === 401 || response.status === 403 ? 'Check the API key and account permissions.'
          : response.status === 429 ? 'The provider quota or rate limit was reached.'
            : response.status === 404 ? 'Check the base URL, model and tool support.' : 'The provider could not complete the request. Try again.';
        throw failure(`AI provider HTTP ${response.status}. ${advice}`, `HTTP_${response.status}`);
      }
      if (!response.body || !/^text\/event-stream\b/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw failure('The endpoint did not return a supported event stream.', 'INVALID_STREAM');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const calls = new Map();
      let buffer = '', data = [], content = '', bytes = 0, done = false, finishReason = null;
      function event() {
        if (!data.length) return;
        const payload = data.join('\n'); data = [];
        if (payload === '[DONE]') { done = true; return; }
        let message;
        try { message = JSON.parse(payload); }
        catch { throw failure('The provider sent an invalid stream event.', 'INVALID_STREAM'); }
        if (message?.error) throw failure('The provider reported a failure during streaming. No proposed changes were applied.', 'STREAM_ERROR');
        const choice = message?.choices?.find(item => item.index === 0) ?? message?.choices?.[0];
        if (!choice) return; // Usage-only terminal event.
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (typeof delta?.content === 'string') {
          content += delta.content;
          onDelta(delta.content);
        }
        if (delta?.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw failure('Invalid streamed tool calls.', 'INVALID_STREAM');
        for (const fragment of delta?.tool_calls || []) {
          if (!Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index >= 16) throw failure('Too many or invalid tool calls.', 'TOOL_LIMIT');
          const call = calls.get(fragment.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (fragment.type && fragment.type !== 'function') throw failure('Unsupported provider tool type.', 'INVALID_STREAM');
          if (fragment.id) {
            if (typeof fragment.id !== 'string' || fragment.id.length > 256) throw failure('Invalid provider tool identifier.', 'INVALID_STREAM');
            call.id = fragment.id;
          }
          for (const key of ['name', 'arguments']) {
            if (fragment.function?.[key] !== undefined) {
              if (typeof fragment.function[key] !== 'string') throw failure('Invalid provider tool delta.', 'INVALID_STREAM');
              call.function[key] += fragment.function[key];
            }
          }
          if (call.function.name.length > 128) throw failure('Invalid provider tool name.', 'INVALID_STREAM');
          calls.set(fragment.index, call);
        }
      }
      function line(value) {
        if (value === '') event();
        else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
      }
      while (!done) {
        controller.signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxResponseBytes) throw failure('The AI response exceeded its size limit. No changes were applied.', 'RESPONSE_LIMIT');
        buffer += decoder.decode(chunk.value, { stream: true });
        let position;
        while ((position = buffer.indexOf('\n')) !== -1 && !done) {
          line(buffer.slice(0, position).replace(/\r$/, ''));
          buffer = buffer.slice(position + 1);
        }
      }
      buffer += decoder.decode();
      if (!done && buffer) line(buffer.replace(/\r$/, ''));
      if (!done) event();
      if (!done || !['stop', 'tool_calls'].includes(finishReason)) {
        throw failure('The AI response ended before completion. Partial tool calls were discarded; try again.', 'INCOMPLETE_STREAM');
      }
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
      const identifiers = new Set();
      for (const call of toolCalls) {
        if (!call.id || !call.function.name || identifiers.has(call.id)) throw failure('Invalid completed tool call.', 'INVALID_STREAM');
        identifiers.add(call.id);
        try {
          const args = JSON.parse(call.function.arguments);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
        } catch { throw failure('The provider returned incomplete or invalid tool arguments.', 'INVALID_STREAM'); }
      }
      if (toolCalls.length && finishReason !== 'tool_calls') throw failure('The provider did not complete its tool calls.', 'INCOMPLETE_STREAM');
      return { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    } catch (error) {
      if (timedOut) throw failure('The AI request timed out. Your project files were not changed.', 'TIMEOUT');
      if (controller.signal.aborted) throw new DOMException('AI request cancelled.', 'AbortError');
      if (failures.has(error)) throw error;
      throw failure('Cannot reach the AI provider. Check its browser-access policy, network and endpoint. Your project remains available.', 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      requests.delete(controller);
      try { await reader?.cancel(); } catch { /* Already closed or aborted. */ }
      reader?.releaseLock();
    }
  }
  return Object.freeze({ stream, dispose() { disposed = true; apiKey = ''; for (const request of requests) request.abort(); requests.clear(); } });
}

/** Documentation-backed candidate only. Live authenticated browser verification is still required. */
export const AI_PROVIDER_CANDIDATES = Object.freeze([
  Object.freeze({ id: 'openrouter', label: 'OpenRouter (verification required)', baseURL: 'https://openrouter.ai/api/v1',
    verified: false, documentation: 'https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request' }),
]);
