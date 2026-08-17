import { describe, expect, it } from "vitest";

import {
  CreateSceneInputSchema,
  PatchPreviewSettingsRequestSchema,
  PutProjectFileRequestSchema,
  type ProjectId,
} from "@vidcom/contracts";
import { ignoredMutationOriginForActor, NOOP_MUTATION_OBSERVER } from "@vidcom/core";
import { UNTRACKED_UI_ORIGIN } from "../../packages/server/src/routes/mutation-origin";

describe("mutation origin bridge", () => {
  it("provides one named, non-throwing observer bridge for pre-history wiring", () => {
    const origin = ignoredMutationOriginForActor("agent");
    const projectId = "project-1" as ProjectId;
    expect(NOOP_MUTATION_OBSERVER.claimHistoryOperation(projectId, origin)).toEqual({ ok: true });
    expect(NOOP_MUTATION_OBSERVER.emit({
      id: "journal:1",
      projectId,
      origin,
      steps: [],
      paths: [],
      readGuards: [],
      projectRevision: 1,
      at: "2026-08-17T00:00:00.000Z",
      undoable: false,
    })).toEqual({ ok: true });
    expect(() => {
      NOOP_MUTATION_OBSERVER.abortHistoryOperation(projectId, origin);
      NOOP_MUTATION_OBSERVER.blockHistoryOperation(projectId, origin, []);
      NOOP_MUTATION_OBSERVER.observeExternalChange(projectId, []);
      NOOP_MUTATION_OBSERVER.invalidateProject(projectId, "history-desync");
    }).not.toThrow();
  });

  it("uses the named P0 browser bridge without recording history", () => {
    expect(UNTRACKED_UI_ORIGIN).toEqual({
      kind: "ui",
      sessionId: null,
      label: null,
      historyAction: "ignore",
      historyOperation: null,
    });
  });

  it("maps every existing actor to one redacted, non-history origin", () => {
    expect([
      ignoredMutationOriginForActor("user"),
      ignoredMutationOriginForActor("agent"),
      ignoredMutationOriginForActor("cli-external"),
      ignoredMutationOriginForActor("system"),
    ]).toEqual([
      { kind: "ui", sessionId: null, label: null, historyAction: "ignore", historyOperation: null },
      { kind: "mcp", sessionId: null, label: null, historyAction: "ignore", historyOperation: null },
      { kind: "cli", sessionId: null, label: null, historyAction: "ignore", historyOperation: null },
      { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null },
    ]);
  });

  it("keeps history read guards out of HTTP and MCP transport schemas", () => {
    const historyReadGuards = [{
      path: "assets/font.woff2",
      state: { kind: "file", contentHash: `sha256:${"0".repeat(64)}` },
    }];
    const httpInput = {
      path: "index.html",
      content: "next",
      expectedContentHash: null,
    };
    const mcpInput = {
      projectId: "project-1",
      title: "Scene",
      expectedContentHash: null,
    };
    expect(PutProjectFileRequestSchema.safeParse(httpInput).success).toBe(true);
    expect(CreateSceneInputSchema.safeParse(mcpInput).success).toBe(true);
    expect(PutProjectFileRequestSchema.safeParse({
      ...httpInput,
      historyReadGuards,
    }).success).toBe(false);
    expect(CreateSceneInputSchema.safeParse({
      ...mcpInput,
      historyReadGuards,
    }).success).toBe(false);
    const previewInput = { patch: { bgm: { enabled: false } }, expectedRevision: 0 };
    expect(PatchPreviewSettingsRequestSchema.safeParse(previewInput).success).toBe(true);
    expect(PatchPreviewSettingsRequestSchema.safeParse({ ...previewInput, undoable: true }).success).toBe(false);
  });
});
