import { describe, expect, it } from "vitest";

import { TOOL_SCHEMA_CATALOGUE } from "@vidcom/contracts";
import {
  registerVidcomTools,
  ToolRegistry,
  type VidcomToolDependencies,
} from "@vidcom/mcp";
import type { ApprovalService, ToolAuditService } from "@vidcom/core";

function registeredTools() {
  const registry = new ToolRegistry({
    audit: null as unknown as ToolAuditService,
    approvals: { request: null as unknown as ApprovalService["request"] },
  });
  registerVidcomTools(registry, null as unknown as VidcomToolDependencies);
  return registry.list("modern");
}

describe("MCP tool schema catalogue", () => {
  it("matches the complete registry in both directions", () => {
    const registered = registeredTools();
    expect(Object.keys(TOOL_SCHEMA_CATALOGUE).sort()).toEqual(
      registered.map((tool) => tool.name),
    );
  });

  it("is the exact schema and level source consumed by the registry", () => {
    for (const tool of registeredTools()) {
      const entry = TOOL_SCHEMA_CATALOGUE[
        tool.name as keyof typeof TOOL_SCHEMA_CATALOGUE
      ];
      expect(entry, `missing catalogue entry for ${tool.name}`).toBeDefined();
      expect(tool.inputSchema).toBe(entry.input);
      expect(tool.outputSchema).toBe(entry.output);
      expect(tool.level).toBe(entry.level);
    }
  });
});
