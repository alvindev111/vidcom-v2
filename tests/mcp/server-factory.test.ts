import { describe, expect, it } from "vitest";

import { GetProjectContextInputSchema, type ProjectId } from "@vidcom/contracts";
import {
  createServerFactory,
  MCP_SERVER_INFO,
  ToolRegistry,
  type ToolDefinition,
} from "@vidcom/mcp";
import packageMetadata from "../../packages/mcp/package.json";

function testRegistry(): ToolRegistry {
  const registry = new ToolRegistry({
    audit: null as never,
    approvals: { request: null as never },
  });
  const definition = (name: string, availableInLegacy: boolean): ToolDefinition<
    { projectId: string },
    { projectId: string }
  > => ({
    name,
    title: `${name} title`,
    level: "read",
    description: `${name} description`,
    input: GetProjectContextInputSchema,
    output: GetProjectContextInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    availableInLegacy,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => ({ ok: true, value: input }),
  });
  registry.register(definition("shared_tool", true));
  registry.register(definition("modern_tool", false));
  return registry;
}

describe("MCP server factory", () => {
  it("uses the package identity and one Registry registration seam for both eras", async () => {
    expect(MCP_SERVER_INFO).toEqual({
      name: "vidcom-mcp-server",
      version: packageMetadata.version,
    });

    const factory = createServerFactory(testRegistry());
    const legacy = await factory({ era: "legacy" });
    const modern = await factory({ era: "modern" });

    expect("toolInputSchemaJson" in legacy).toBe(true);
    expect("toolInputSchemaJson" in modern).toBe(true);
    if (!("toolInputSchemaJson" in legacy) || !("toolInputSchemaJson" in modern)) {
      throw new TypeError("factory did not return a high-level MCP server");
    }
    expect(legacy.toolInputSchemaJson("shared_tool")).toBeDefined();
    expect(modern.toolInputSchemaJson("shared_tool")).toBeDefined();
    expect(legacy.toolInputSchemaJson("modern_tool")).toBeUndefined();
    expect(modern.toolInputSchemaJson("modern_tool")).toBeDefined();
  });
});
