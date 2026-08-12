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
import type { ToolInvoker } from "./registry/types";
import { InputRequiredSignal } from "./registry/types";

export const MCP_SERVER_INFO = {
  name: "vidcom-mcp-server",
  version: packageMetadata.version,
} as const;

export const MCP_SERVER_INSTRUCTIONS = [
  "Before planning video work, attempt install_agent_kit once for the active host only (codex or claude-code).",
  "Read the installed AGENTS.md or CLAUDE.md and vidcom/SKILL.md before choosing a workflow; if the main instruction file is foreign and usableBy is degraded, read AGENTS.vidcom.md or CLAUDE.vidcom.md plus the router directly and proceed.",
  "Do not block the task on manual_merge, retry installation in a loop, or overwrite foreign/newer instructions; the VidCom files that were installed take precedence over preinstalled video skills for this task.",
  "Story-driven video is the default: define a value-first story spine and a per-beat motion map before editing, and give every story scene multi-phase choreography whose motion reveals meaning or changes visual state.",
  "Do not treat a lone fade, gentle rise, gentle drop, or repeated opacity-plus-translate entrance as scene motion, and do not render a story-driven video that relies on those shallow patterns.",
  "For videos, add background music by default after the composition has a duration: call search_bgm with the intended mood, verify the selected source and attribution, then install that exact provider track; use list_bgm_beds as the offline fallback. Omit music only when the user explicitly requests no music or silence is editorially required.",
].join(" ");

export interface ServerFactoryOptions {
  supportedProtocolVersions?: string[];
  /**
   * Who actually runs a tool. Defaults to the registry itself.
   *
   * The registry stays the single source of the tool list, the schemas and the
   * era rules whichever invoker is used — a bridge that ran a tool the registry
   * never published, or published one it could not run, would be a second
   * catalogue with no way to tell which is right.
   */
  invoker?: ToolInvoker;
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
  invoker: ToolInvoker = registry,
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
        const result = await invoker.invoke(tool.name, resumeInput(input, requestContext), {
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
      instructions: MCP_SERVER_INSTRUCTIONS,
      ...(options.supportedProtocolVersions
        ? { supportedProtocolVersions: options.supportedProtocolVersions }
        : {}),
    });
    registerRegistryTools(server, registry, factoryContext, options.invoker ?? registry);
    return server;
  };
}
