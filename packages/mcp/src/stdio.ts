import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { SUPPORTED_REVISIONS } from "@vidcom/contracts";

import type { ToolRegistry } from "./registry/registry";
import type { ToolInvoker } from "./registry/types";
import { createServerFactory } from "./server";

export interface McpTransportDependencies {
  onerror?(error: Error): void;
  transport?: NonNullable<Parameters<typeof serveStdio>[1]>["transport"];
  stdin?: StdioLifecycleSource;
  stdout?: StdioLifecycleSource;
}

export interface StdioLifecycleSource {
  once(event: "end" | "close", listener: () => void): unknown;
  removeListener(event: "end" | "close", listener: () => void): unknown;
}

export interface VidcomStdioHandle {
  close(): Promise<void>;
  /** Settles after stdin EOF, stdout close, or an explicit close finishes. */
  closed: Promise<void>;
}

export interface StartMcpStdioOptions {
  pinnedRevision?: string;
  /** Executes the published catalogue somewhere other than this stdio process. */
  invoker?: ToolInvoker;
}

/** Starts the SDK-owned dual-era stdio entry; stdout remains protocol-only. */
export async function startMcpStdio(
  registry: ToolRegistry,
  dependencies: McpTransportDependencies = {},
  options: StartMcpStdioOptions = {},
): Promise<VidcomStdioHandle> {
  const factory = createServerFactory(registry, {
    ...(options.pinnedRevision
      ? { supportedProtocolVersions: [options.pinnedRevision] }
      : {}),
    ...(options.invoker ? { invoker: options.invoker } : {}),
  });
  const handle = serveStdio(factory, {
    legacy: options.pinnedRevision === SUPPORTED_REVISIONS[0] ? "reject" : "serve",
    ...(dependencies.onerror ? { onerror: dependencies.onerror } : {}),
    ...(dependencies.transport ? { transport: dependencies.transport } : {}),
  });
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let closePromise: Promise<void> | null = null;
  const disconnect = () => { void close().catch(() => undefined); };
  const close = () => closePromise ??= (async () => {
    stdin.removeListener("end", disconnect);
    stdout.removeListener("close", disconnect);
    try { await handle.close(); }
    finally { resolveClosed(); }
  })();
  stdin.once("end", disconnect);
  stdout.once("close", disconnect);
  return { close, closed };
}
