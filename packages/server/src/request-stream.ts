import type { IncomingMessage } from "node:http";

const incomingByRequest = new WeakMap<Request, IncomingMessage>();

/** Records the HTTP/1.1 source without exposing it through the application contract. */
export function registerIncomingRequest(request: Request, incoming: IncomingMessage): void {
  incomingByRequest.set(request, incoming);
}

/** Uses the native backpressured stream on the real listener and the Web stream in in-process tests. */
export async function* requestBodyChunks(request: Request): AsyncIterable<Uint8Array> {
  const incoming = incomingByRequest.get(request);
  if (incoming) {
    incomingByRequest.delete(request);
    for await (const chunk of incoming) {
      if (typeof chunk === "string") yield Buffer.from(chunk);
      else if (chunk.byteLength > 0) yield chunk;
    }
    return;
  }
  const body = request.body;
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      if (next.value.byteLength > 0) yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}
