export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export async function serializeRequest(request) {
  const body = ['GET', 'HEAD'].includes(request.method) ? null : new Uint8Array(await request.arrayBuffer());
  if (body?.byteLength > MAX_BODY_BYTES) throw new RangeError('The HTTP request exceeds 64 MiB');
  return { url: request.url, method: request.method, headers: [...request.headers], body };
}

export async function serializeResponse(response) {
  if (!(response instanceof Response)) throw new Error('PHP did not return an HTTP response');
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new RangeError('The HTTP response exceeds 64 MiB');
  return { status: response.status, statusText: response.statusText, headers: [...response.headers], body };
}

export function restoreResponse(value, method = 'GET') {
  const empty = method === 'HEAD' || [101, 204, 205, 304].includes(value.status);
  return new Response(empty ? null : value.body, { status: value.status, statusText: value.statusText, headers: value.headers });
}
