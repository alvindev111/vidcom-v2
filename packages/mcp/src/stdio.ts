import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { SUPPORTED_REVISIONS } from "@vidcom/contracts";

import type { ToolRegistry } from "./registry/registry";
import { createServerFactory } from "./server";

export interface McpTransportDependencies {
  onerror?(error: Error): void;
}

export interface StartMcpStdioOptions {
  pinnedRevision?: string;
}

/** Starts the SDK-owned dual-era stdio entry; stdout remains protocol-only. */
export async function startMcpStdio(
  registry: ToolRegistry,
  dependencies: McpTransportDependencies = {},
  options: StartMcpStdioOptions = {},
): Promise<{ close(): Promise<void> }> {
  const factory = createServerFactory(registry, options.pinnedRevision
    ? { supportedProtocolVersions: [options.pinnedRevision] }
    : {});
  return serveStdio(factory, {
    legacy: options.pinnedRevision === SUPPORTED_REVISIONS[0] ? "reject" : "serve",
    ...(dependencies.onerror ? { onerror: dependencies.onerror } : {}),
  });
}
