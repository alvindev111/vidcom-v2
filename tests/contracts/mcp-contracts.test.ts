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

  it("bounds list_projects pages and applies its deterministic default", () => {
    expect(ListProjectsInputSchema.parse({})).toEqual({ limit: 20 });
    expect(ListProjectsInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(ListProjectsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ListProjectsInputSchema.safeParse({ limit: 10, cursor: "project-10" }).success).toBe(true);
  });

  it("rejects an empty set_scene_timing patch but accepts each timing field", () => {
    const base = {
      projectId: "project-1",
      sceneId: "scene-1",
      expectedContentHash: `sha256:${"1".repeat(64)}`,
    };
    expect(SetSceneTimingInputSchema.safeParse(base).success).toBe(false);
    for (const timing of [{ start: 0 }, { duration: 1 }, { trackIndex: 0 }]) {
      expect(SetSceneTimingInputSchema.safeParse({ ...base, ...timing }).success).toBe(true);
    }
  });

  it("allows set_text to report narration present-stale or absent-not-stale", () => {
    const base = {
      scene: {
        id: "scene-1", src: null, start: 0, duration: 1, trackIndex: 0,
        isTransition: false, elementCount: 1,
        fileContentHash: `sha256:${"1".repeat(64)}`,
        narrationStale: false,
      },
      project: {
        id: "project-1", slug: "project-1", title: "Project", width: 1920, height: 1080,
        duration: 1, updatedAt: "2026-08-02T00:00:00.000Z", sceneCount: 1, revision: 1,
      },
      envelope: { projectRevision: 1, entityRevision: null, fileHashes: {}, diagnostics: [], changeSeq: 1 },
    };
    expect(SetTextOutputSchema.safeParse({ ...base, narrationStale: false }).success).toBe(true);
    expect(SetTextOutputSchema.safeParse({ ...base, narrationStale: true }).success).toBe(true);
  });

  it("rejects non-canonical fileHashes keys in write envelopes", () => {
    const hash = `sha256:${"1".repeat(64)}`;
    const envelope = (path: string) => ({
      projectRevision: 1,
      entityRevision: null,
      fileHashes: { [path]: hash },
      diagnostics: [],
      changeSeq: 1,
    });
    for (const path of [
      "/absolute.html",
      "../escape.html",
      "a/../escape.html",
      "a\\file.html",
      "a//file.html",
      "C:/file.html",
      ".",
    ]) {
      expect(SetTextOutputSchema.shape.envelope.safeParse(envelope(path)).success).toBe(false);
    }
    expect(SetTextOutputSchema.shape.envelope.safeParse(envelope("compositions/scene.html")).success).toBe(true);
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
