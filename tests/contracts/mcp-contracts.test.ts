import { readFile } from "node:fs/promises";

import {
  CreateSceneInputSchema,
  CreateSceneOutputSchema,
  DeleteFileInputSchema,
  DeleteFileOutputSchema,
  DeleteSceneInputSchema,
  DeleteSceneOutputSchema,
  ErrorCode,
  GetProjectContextInputSchema,
  GetProjectContextOutputSchema,
  ListProjectsInputSchema,
  ListProjectsOutputSchema,
  ListScenesInputSchema,
  ListScenesOutputSchema,
  ReadCompositionInputSchema,
  ReadCompositionOutputSchema,
  SaveFileInputSchema,
  SaveFileOutputSchema,
  SetSceneTimingInputSchema,
  SetSceneTimingOutputSchema,
  SetTextInputSchema,
  SetTextOutputSchema,
  SUPPORTED_REVISIONS,
} from "@vidcom/contracts";
import { SDK_SUPPORTED_LEGACY_REVISIONS } from "@vidcom/mcp";
import { describe, expect, it } from "vitest";

const TOOL_SCHEMAS = [
  ListProjectsInputSchema,
  ListProjectsOutputSchema,
  GetProjectContextInputSchema,
  GetProjectContextOutputSchema,
  ListScenesInputSchema,
  ListScenesOutputSchema,
  ReadCompositionInputSchema,
  ReadCompositionOutputSchema,
  CreateSceneInputSchema,
  CreateSceneOutputSchema,
  SetSceneTimingInputSchema,
  SetSceneTimingOutputSchema,
  SetTextInputSchema,
  SetTextOutputSchema,
  SaveFileInputSchema,
  SaveFileOutputSchema,
  DeleteFileInputSchema,
  DeleteFileOutputSchema,
  DeleteSceneInputSchema,
  DeleteSceneOutputSchema,
];

async function packageJson(pathname: URL): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}> {
  return JSON.parse(await readFile(pathname, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

describe("MCP contracts", () => {
  it("keeps every tool input and output object strict", () => {
    for (const schema of TOOL_SCHEMAS) {
      const result = schema.safeParse({ unexpected: true });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true);
      }
    }
  });

  it("locks the Phase 2 error vocabulary", () => {
    expect(Object.values(ErrorCode)).toEqual(expect.arrayContaining([
      "approval_required",
      "approval_expired",
      "approval_invalid",
      "credential_invalid",
      "tool_not_available_in_era",
      "referenced_by_composition",
      "backup_failed",
      "backup_expired",
      "duplicate_mutation_target",
      "recovery_required",
    ]));
  });

  it("keeps the SDK-neutral revision list aligned with the pinned SDK", () => {
    expect(SUPPORTED_REVISIONS[0]).toBe("2026-07-28");
    expect(SUPPORTED_REVISIONS.slice(1)).toEqual(SDK_SUPPORTED_LEGACY_REVISIONS);
  });

  it("pins runtime and test dependencies in their approved packages", async () => {
    const [root, mcp] = await Promise.all([
      packageJson(new URL("../../package.json", import.meta.url)),
      packageJson(new URL("../../packages/mcp/package.json", import.meta.url)),
    ]);
    expect(root.dependencies?.["@modelcontextprotocol/client"]).toBeUndefined();
    expect(root.devDependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(root.devDependencies?.["@modelcontextprotocol/sdk"]).toBe("1.30.0");
    expect(mcp.dependencies).toMatchObject({
      "@modelcontextprotocol/server": "2.0.0",
      "@modelcontextprotocol/core": "2.0.0",
      zod: "4.4.3",
    });
    expect(mcp.dependencies?.["@vidcom/adapter"]).toBeUndefined();
  });
});
