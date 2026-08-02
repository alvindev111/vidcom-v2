import {
  classifyInboundRequest,
  createMcpHandler,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  isJSONRPCNotification,
  isJSONRPCRequest,
  UnsupportedProtocolVersionError,
  type AuthInfo,
} from "@modelcontextprotocol/server";

import { SUPPORTED_REVISIONS } from "@vidcom/contracts";

import type { ToolRegistry } from "./registry/registry";
import { createServerFactory } from "./server";
import type { McpTransportDependencies } from "./stdio";

export type McpFetchHandler = (
  request: Request,
  options?: { authInfo?: AuthInfo },
) => Promise<Response>;

export interface McpHttpHandlers {
  handlers: ReadonlyMap<string, McpFetchHandler>;
  defaultRevision: string;
  close(): Promise<void>;
}

function unsupportedRevisionResponse(
  requestedRevision: string,
  body: unknown,
): Response {
  if (isJSONRPCNotification(body)) return new Response(null, { status: 202 });
  const error = new UnsupportedProtocolVersionError({
    supported: [...SUPPORTED_REVISIONS],
    requested: requestedRevision,
  });
  return Response.json({
    jsonrpc: "2.0",
    error: { code: error.code, message: error.message, data: error.data },
    id: isJSONRPCRequest(body) ? body.id : null,
  }, { status: 400 });
}

function pinnedHandler(
  pinnedRevision: string,
  inner: McpFetchHandler,
  unsupportedRequested?: string,
): McpFetchHandler {
  return async (request, options) => {
    let body: unknown;
    try {
      body = request.method === "POST" ? await request.clone().json() : undefined;
    } catch {
      return inner(request, options);
    }
    const outcome = classifyInboundRequest({
      httpMethod: request.method,
      protocolVersionHeader: request.headers.get("MCP-Protocol-Version") ?? undefined,
      mcpMethodHeader: request.headers.get("Mcp-Method") ?? undefined,
      mcpNameHeader: request.headers.get("Mcp-Name") ?? undefined,
      body,
    });
    if (outcome.kind === "reject") return inner(request, options);
    const actualRevision = outcome.kind === "modern"
      ? outcome.classification.revision
      : outcome.requestedVersion ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
    return actualRevision === pinnedRevision
      ? inner(request)
      : unsupportedRevisionResponse(unsupportedRequested ?? actualRevision ?? "unknown", body);
  };
}

class RevisionHandlerMap extends Map<string, McpFetchHandler> {
  constructor(
    entries: Iterable<readonly [string, McpFetchHandler]>,
    private readonly fallback: (revision: string) => McpFetchHandler,
  ) {
    super(entries);
  }

  override get(revision: string): McpFetchHandler | undefined {
    return super.get(revision) ?? this.fallback(revision);
  }
}

/** Creates the unpinned SDK entry; revision-addressed handlers are added later in Phase M. */
export function createMcpHttpHandlers(
  registry: ToolRegistry,
  dependencies: McpTransportDependencies = {},
): McpHttpHandlers {
  const entry = createMcpHandler(createServerFactory(registry), {
    ...(dependencies.onerror ? { onerror: dependencies.onerror } : {}),
  });
  const closers = [entry];
  const handlers = new RevisionHandlerMap([["", entry.fetch]], (revision) =>
    pinnedHandler("__unsupported__", entry.fetch, revision));
  for (const revision of SUPPORTED_REVISIONS) {
    const pinned = createMcpHandler(
      createServerFactory(registry, { supportedProtocolVersions: [revision] }),
      {
        ...(revision === SUPPORTED_REVISIONS[0] ? { legacy: "reject" as const } : {}),
        ...(dependencies.onerror ? { onerror: dependencies.onerror } : {}),
      },
    );
    closers.push(pinned);
    handlers.set(revision, pinnedHandler(revision, pinned.fetch));
  }
  handlers.set("latest", handlers.get(SUPPORTED_REVISIONS[0])!);
  return {
    handlers,
    defaultRevision: SUPPORTED_REVISIONS[0],
    close: async () => { await Promise.all(closers.map((handler) => handler.close())); },
  };
}
