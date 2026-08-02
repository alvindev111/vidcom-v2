import {
  acceptedContent,
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  inputRequired,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type ElicitRequestFormParams,
  type McpRequestContext,
  type McpServerFactory,
  type ServerContext,
} from "@modelcontextprotocol/server";

import packageMetadata from "../package.json";
import { canonicalizeJson } from "@vidcom/core";
import { mcpToolError } from "./error-map";
import type { ToolRegistry } from "./registry/registry";
import { InputRequiredSignal } from "./registry/types";

export const MCP_SERVER_INFO = {
  name: "vidcom-mcp-server",
  version: packageMetadata.version,
} as const;

export interface ServerFactoryOptions {
  supportedProtocolVersions?: string[];
}

function protocolVersionOf(
  server: McpServer,
  factoryContext: McpRequestContext,
  context: ServerContext,
): string {
  const envelopeVersion = (context.mcpReq.envelope as Record<string, unknown> | undefined)
    ?.[PROTOCOL_VERSION_META_KEY];
  if (typeof envelopeVersion === "string") return envelopeVersion;
  const negotiatedVersion = server.server.getNegotiatedProtocolVersion();
  if (negotiatedVersion) return negotiatedVersion;
  if (factoryContext.era === "legacy" && factoryContext.requestInfo) {
    return factoryContext.requestInfo.headers.get("MCP-Protocol-Version")
      ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
  }
  throw new Error("MCP tool invoked before protocol negotiation");
}

function credentialIdOf(factoryContext: McpRequestContext, requestContext: ServerContext): string | null {
  return requestContext.http?.authInfo?.clientId ?? factoryContext.authInfo?.clientId ?? null;
}

function resumeInput(raw: unknown, context: ServerContext): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "grantId" in raw) return raw;
  const approval = acceptedContent<Record<string, unknown>>(context.mcpReq.inputResponses, "approval");
  return typeof approval?.grantId === "string" ? { ...raw, grantId: approval.grantId } : raw;
}

/** Sole Registry-to-SDK registration seam shared by both eras and transports. */
export function registerRegistryTools(
  server: McpServer,
  registry: ToolRegistry,
  factoryContext: McpRequestContext,
): void {
  for (const tool of registry.list(factoryContext.era)) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }, async (input, requestContext) => {
      try {
        const result = await registry.invoke(tool.name, resumeInput(input, requestContext), {
          era: factoryContext.era,
          protocolVersion: protocolVersionOf(server, factoryContext, requestContext),
          credentialId: credentialIdOf(factoryContext, requestContext),
          requestInput: async (request): Promise<never> => { throw new InputRequiredSignal(request); },
        });
        if (!result.ok) return mcpToolError(result.error, factoryContext.era);
        const output = result.value as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: canonicalizeJson(output) }],
          structuredContent: output,
        };
      } catch (error) {
        if (!(error instanceof InputRequiredSignal)) throw error;
        return inputRequired({
          inputRequests: {
            approval: inputRequired.elicit({
              message: error.request.message,
              requestedSchema: error.request.schema as ElicitRequestFormParams["requestedSchema"],
            }),
          },
          requestState: error.request.requestState,
        });
      }
    });
  }
}

/** Creates one SDK-owned server instance for the serving entry's selected era. */
export function createServerFactory(
  registry: ToolRegistry,
  options: ServerFactoryOptions = {},
): McpServerFactory {
  return (factoryContext) => {
    const server = new McpServer(MCP_SERVER_INFO, {
      ...(options.supportedProtocolVersions
        ? { supportedProtocolVersions: options.supportedProtocolVersions }
        : {}),
    });
    registerRegistryTools(server, registry, factoryContext);
    return server;
  };
}
