const MAX_BYTES = 320 * 1024 * 1024;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Decode CGI input without a string or per-byte character array. */
export async function breakoutRequest(request) {
  const url = new URL(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const header = name => request.headers?.get?.(name) ?? request.headers?.get?.(name.toLowerCase())
    ?? request.headers?.[name.toLowerCase()] ?? null;
  const declared = Number(header('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new RangeError('CGI request exceeds the transport body limit.');
  let post = new Uint8Array(0);
  if (BODY_METHODS.has(method)) {
    const chunks = [];
    let length = 0;
    const append = value => {
      if (!value) return;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      length += bytes.byteLength;
      if (length > MAX_BYTES) throw new RangeError('CGI request exceeds the transport body limit.');
      chunks.push(bytes);
    };
    if (request.body?.getReader) {
      const reader = request.body.getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; append(value); }
      } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
    } else if (request.arrayBuffer) append(await request.arrayBuffer());
    else if (request.body instanceof Uint8Array || request.body instanceof ArrayBuffer) append(request.body);
    else if (request[Symbol.asyncIterator]) for await (const chunk of request) append(chunk);
    else if (request.on) {
      await new Promise((resolve, reject) => {
        request.on('data', chunk => { try { append(chunk); } catch (error) { reject(error); request.destroy?.(); } });
        request.on('end', resolve); request.on('error', reject);
      });
    }
    if (chunks.length === 1) post = chunks[0];
    else if (length) {
      post = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { post.set(chunk, offset); offset += chunk.byteLength; }
    }
  }
  return { url, method, get: url.search.slice(1), post,
    contentType: BODY_METHODS.has(method) ? (header('Content-Type') || 'application/x-www-form-urlencoded') : null };
}
