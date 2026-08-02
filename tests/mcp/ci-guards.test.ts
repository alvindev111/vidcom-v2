import { Client as ModernClient } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { SUPPORTED_REVISIONS } from "@vidcom/contracts";
import { SDK_SUPPORTED_LEGACY_REVISIONS } from "@vidcom/mcp";

import { CONTRACT_MATRIX_CASES, createContractMatrixRegistry } from "./support";

describe("MCP CI guards", () => {
  it("requires a contract case for every production registry tool", () => {
    const registered = createContractMatrixRegistry().list("modern").map((tool) => tool.name).sort();
    expect(Object.keys(CONTRACT_MATRIX_CASES).sort()).toEqual(registered);
  });

  it("keeps the contracts allowlist aligned with both exact SDK eras", () => {
    expect(SUPPORTED_REVISIONS.slice(1)).toEqual([...SDK_SUPPORTED_LEGACY_REVISIONS]);
    expect(() => new ModernClient(
      { name: "vidcom-revision-guard", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: SUPPORTED_REVISIONS[0] } } },
    )).not.toThrow();
  });
});
