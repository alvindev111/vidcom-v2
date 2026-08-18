import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { getRequestListener, type ServerType } from "@hono/node-server";

import { registerIncomingRequest } from "./request-stream";

export interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
}

function isRawAssetUpload(request: IncomingMessage): boolean {
  const pathname = request.url?.split("?", 1)[0] ?? "";
  return request.method === "POST" && /^\/api\/v1\/projects\/[^/]+\/assets$/.test(pathname);
}

async function writeResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { outgoing.end(); return; }
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!outgoing.write(next.value)) await once(outgoing, "drain");
    }
    outgoing.end();
  } finally {
    reader.releaseLock();
  }
}

async function dispatchRawAssetUpload(
  app: FetchApp,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const abort = new AbortController();
  incoming.once("aborted", () => abort.abort(new Error("asset upload connection aborted")));
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  }
  const init: RequestInit = {
    method: "POST",
    headers,
    body: new Uint8Array(0),
    signal: abort.signal,
  };
  const request = new Request(new URL(incoming.url ?? "/", "http://127.0.0.1"), init);
  registerIncomingRequest(request, incoming);
  try {
    await writeResponse(await app.fetch(request), outgoing);
  } finally {
    if (!incoming.readableEnded && !incoming.destroyed) incoming.resume();
  }
}

export class LoopbackBindError extends Error {
  constructor(readonly port: number, options?: ErrorOptions) {
    super(`could not bind loopback port ${port}`, options);
    this.name = "LoopbackBindError";
  }
}

export interface LoopbackListener {
  hostname: "127.0.0.1";
  port: number;
  server: ServerType;
  close(): Promise<void>;
}

/** Opens only IPv4 loopback; port zero delegates dynamic selection to the OS. */
export function bindLoopback(appFactory: (port: number) => FetchApp, port?: number): Promise<LoopbackListener>;
export function bindLoopback(app: FetchApp, port: number): Promise<LoopbackListener>;
export function bindLoopback(
  appSource: FetchApp | ((port: number) => FetchApp),
  port = 0,
): Promise<LoopbackListener> {
  return new Promise((resolve, reject) => {
    let app = typeof appSource === "function" ? undefined : appSource;
    const standard = getRequestListener((request) => app
      ? app.fetch(request)
      : new Response("listener is starting", { status: 503 }), { hostname: "127.0.0.1" });
    const server = createServer((incoming, outgoing) => {
      if (app && isRawAssetUpload(incoming)) {
        void dispatchRawAssetUpload(app, incoming, outgoing).catch((cause) => {
          if (!outgoing.headersSent) outgoing.writeHead(500);
          outgoing.end();
          incoming.destroy(cause instanceof Error ? cause : undefined);
        });
        return;
      }
      void standard(incoming, outgoing);
    });
    const onError = (cause: Error) => reject(new LoopbackBindError(port, { cause }));
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new LoopbackBindError(port));
        return;
      }
      if (typeof appSource === "function") {
        try { app = appSource(address.port); }
        catch (cause) {
          server.close(() => reject(new LoopbackBindError(address.port, { cause })));
          return;
        }
      }
      resolve({
        hostname: "127.0.0.1",
        port: address.port,
        server,
        close: () => new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
    server.listen(port, "127.0.0.1");
  });
}
