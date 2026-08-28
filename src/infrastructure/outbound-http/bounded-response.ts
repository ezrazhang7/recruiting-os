export class ResponseSizeLimitError extends Error {
  constructor() {
    super('Response exceeds size limit');
  }
}

export async function boundedResponse(
  response: Response,
  maxBytes: number,
  url?: string,
): Promise<Response> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ResponseSizeLimitError();
  }
  const body = await readLimited(response.body, maxBytes);
  const arrayBuffer = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  const result = new Response(body.byteLength ? arrayBuffer : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  if (url ?? response.url) Object.defineProperty(result, 'url', { value: url ?? response.url });
  return result;
}

async function readLimited(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new ResponseSizeLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
