import { serve, type ServerType } from "@hono/node-server";

export interface FetchApp {
  fetch(request: Request): Response | Promise<Response>;
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
    const server = serve({
      fetch: (request) => app
        ? app.fetch(request)
        : new Response("listener is starting", { status: 503 }),
      hostname: "127.0.0.1",
      port,
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
  });
}
