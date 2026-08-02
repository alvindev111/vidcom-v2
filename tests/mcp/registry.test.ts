import { describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import type { ApprovalService, GrantBinding, PendingToolAudit, ToolAuditEntry } from "@vidcom/core";
import { ToolAuditService } from "@vidcom/core";
import {
  annotationsForLevel,
  listProjectsTool,
  getProjectContextTool,
  listScenesTool,
  readCompositionTool,
  createSceneTool,
  setSceneTimingTool,
  setTextTool,
  saveFileTool,
  deleteSceneTool,
  InputRequiredSignal,
  requestSceneDeletionApproval,
  deleteFileTool,
  registerVidcomTools,
  type VidcomToolDependencies,
  ToolRegistry,
  type ToolDefinition,
} from "@vidcom/mcp";

function registry(): ToolRegistry {
  return new ToolRegistry({
    audit: null as unknown as ToolAuditService,
    approvals: { request: null as unknown as ApprovalService["request"] },
  });
}

function definition(
  name: string,
  level: "read" | "write" | "job" | "destructive",
  availableInLegacy = true,
): ToolDefinition<{ projectId: string }, { value: string }> {
  const input = {
    parse(raw: unknown) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || Object.keys(raw).some((key) => key !== "projectId")
        || typeof (raw as { projectId?: unknown }).projectId !== "string") throw new TypeError("invalid input");
      return raw as { projectId: string };
    },
  } as unknown as ToolDefinition<{ projectId: string }, { value: string }>["input"];
  const output = {
    parse(raw: unknown) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)
        || Object.keys(raw).some((key) => key !== "value")
        || typeof (raw as { value?: unknown }).value !== "string") throw new TypeError("invalid output");
      return raw as { value: string };
    },
  } as unknown as ToolDefinition<{ projectId: string }, { value: string }>["output"];
  return {
    name,
    title: `${name} title`,
    level,
    description: `${name} description`,
    input,
    output,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    availableInLegacy,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => ({ ok: true, value: { value: input.projectId } }),
  };
}

describe("ToolRegistry definitions", () => {
  it("derives immutable annotations from every level", () => {
    expect(annotationsForLevel("read")).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(annotationsForLevel("write")).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    });
    expect(annotationsForLevel("job")).toEqual({
      readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
    });
    expect(annotationsForLevel("destructive")).toEqual({
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
    });
  });

  it("lists deterministically and filters modern-only definitions in legacy era", () => {
    const tools = registry();
    tools.register(definition("z_tool", "destructive", false));
    tools.register(definition("a_tool", "read"));
    tools.register(definition("m_tool", "write"));

    expect(tools.list("modern").map((tool) => tool.name)).toEqual(["a_tool", "m_tool", "z_tool"]);
    expect(tools.list("legacy").map((tool) => tool.name)).toEqual(["a_tool", "m_tool"]);
    expect(tools.list("modern")[0]).toMatchObject({
      name: "a_tool",
      title: "a_tool title",
      description: "a_tool description",
      level: "read",
      annotations: annotationsForLevel("read"),
    });
  });

  it("rejects duplicate registration", () => {
    const tools = registry();
    tools.register(definition("same", "read"));
    expect(() => tools.register(definition("same", "write"))).toThrow("already registered");
  });

  it("validates output with the definition-owned strict schema", () => {
    const tools = registry();
    tools.register(definition("read", "read"));
    expect(tools.validateOutput("read", { value: "ok" })).toEqual({ value: "ok" });
    expect(() => tools.validateOutput("read", { value: 1 })).toThrow();
    expect(() => tools.validateOutput("read", { value: "ok", extra: true })).toThrow();
  });

  it("defines list_projects as a concise project-selection read tool", () => {
    const tool = listProjectsTool(null as unknown as Parameters<typeof listProjectsTool>[0]);
    expect(tool).toMatchObject({
      name: "list_projects",
      title: "List VidCom projects",
      level: "read",
      availableInLegacy: true,
      annotations: annotationsForLevel("read"),
    });
    expect(tool.description).toContain("projectId");
    expect(tool.projectIdOf({})).toBeNull();
  });

  it.each([
    [getProjectContextTool, "get_project_context", ["file hashes", "recovery"]],
    [listScenesTool, "list_scenes", ["source hash", "project revision", "recovery"]],
  ] as const)("defines %s with next-action precondition metadata", (factory, name, phrases) => {
    const tool = factory(null as unknown as Parameters<typeof factory>[0]);
    expect(tool).toMatchObject({ name, level: "read", annotations: annotationsForLevel("read") });
    expect(tool.projectIdOf({ projectId: "project-1" })).toBe("project-1");
    for (const phrase of phrases) expect(tool.description.toLowerCase()).toContain(phrase);
  });

  it("defines read_composition with bounded path, size, hash and recovery guidance", () => {
    const tool = readCompositionTool(null as unknown as Parameters<typeof readCompositionTool>[0]);
    expect(tool).toMatchObject({ name: "read_composition", level: "read", availableInLegacy: true });
    expect(tool.description).toContain("project-relative");
    expect(tool.description).toContain("content hash");
    expect(tool.description).toContain("source-size limit");
  });

  it.each([
    [createSceneTool, "create_scene", "entry-file expectedContentHash"],
    [setSceneTimingTool, "set_scene_timing", "expectedContentHash"],
  ] as const)("defines write tool %s with precondition and complete-output guidance", (factory, name, phrase) => {
    const tool = factory(null as unknown as Parameters<typeof factory>[0]);
    expect(tool).toMatchObject({ name, level: "write", annotations: annotationsForLevel("write") });
    expect(tool.description).toContain(phrase);
    expect(tool.description).toMatch(/scene|project/i);
  });

  it("documents set_text narration staleness without implying TTS execution", () => {
    const tool = setTextTool(null as unknown as Parameters<typeof setTextTool>[0]);
    expect(tool.description).toContain("narrationStale=true");
    expect(tool.description).toContain("does not run TTS");
  });

  it("documents save_file allowlist, protected paths, size and returned hash", () => {
    const tool = saveFileTool(null as unknown as Parameters<typeof saveFileTool>[0]);
    expect(tool.description).toContain("allowlisted");
    expect(tool.description).toContain("Protected");
    expect(tool.description).toContain("oversized");
    expect(tool.description).toContain("content hash");
  });

  it("defines delete_scene as destructive with approval, backup and complete-cleanup guidance", () => {
    const tool = deleteSceneTool(null as unknown as Parameters<typeof deleteSceneTool>[0]);
    expect(tool).toMatchObject({
      name: "delete_scene",
      level: "destructive",
      annotations: annotationsForLevel("destructive"),
    });
    for (const phrase of ["grantId", "approval request", "verified backup", "narration", "root duration"]) {
      expect(tool.description).toContain(phrase);
    }
  });

  it("defines delete_file with reference safety, approval, verified backup and complete output", () => {
    const tool = deleteFileTool(null as unknown as Parameters<typeof deleteFileTool>[0]);
    expect(tool).toMatchObject({
      name: "delete_file",
      level: "destructive",
      annotations: annotationsForLevel("destructive"),
    });
    for (const phrase of ["unreferenced", "protected", "verified backup", "backupId", "revision envelope"]) {
      expect(tool.description).toContain(phrase);
    }
  });
});

const request = {
  era: "modern" as const,
  protocolVersion: "2025-06-18",
  credentialId: "credential-1",
  requestInput: async (): Promise<never> => { throw new Error("input required"); },
};

function invokingRegistry(options: { owned?: boolean; records: ToolAuditEntry[] }): ToolRegistry {
  const audit = new ToolAuditService(
    { record: async (entry) => { options.records.push(entry); } },
    { now: () => new Date("2026-08-02T00:00:00.000Z") },
    { warn: () => undefined, error: () => undefined },
    { increment: () => undefined, observeMilliseconds: () => undefined },
    { isJournalOwned: async () => options.owned ?? false },
  );
  return new ToolRegistry({
    audit,
    approvals: { request: null as unknown as ApprovalService["request"] },
  }, {
    newInvocationId: () => "invocation-registry-1",
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
}

describe("ToolRegistry invoke pipeline", () => {
  it("validates strict input before handler and records a pre-T1 failure", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = invokingRegistry({ records });
    let handlerCalls = 0;
    tools.register({
      ...definition("save_file", "write"),
      handler: async () => { handlerCalls += 1; return { ok: true, value: { value: "unexpected" } }; },
    });

    await expect(tools.invoke("save_file", { projectId: "project-1", extra: true }, request))
      .resolves.toMatchObject({ ok: false, error: { code: "schema_invalid", field: "input" } });
    expect(handlerCalls).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tool: "save_file", outcome: "error", errorCode: "schema_invalid" });
  });

  it("forwards the exact prepared WriteInvocation and requires durable ownership on success", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = invokingRegistry({ owned: true, records });
    let forwarded: PendingToolAudit | null = null;
    tools.register({
      ...definition("save_file", "write"),
      handler: async (context, input) => {
        forwarded = context.writeInvocation.toolAudit;
        expect(context).toMatchObject({
          actor: "agent",
          invocationId: "invocation-registry-1",
          credentialId: "credential-1",
          grantId: null,
        });
        return { ok: true, value: { value: input.projectId } };
      },
    });

    await expect(tools.invoke("save_file", { projectId: "project-1" }, request))
      .resolves.toEqual({ ok: true, value: { value: "project-1" } });
    expect(forwarded).toMatchObject({
      schemaVersion: 1,
      invocationId: "invocation-registry-1",
      tool: "save_file",
      projectId: "project-1",
      protocolVersion: "2025-06-18",
      credentialId: "credential-1",
    });
    expect(records).toEqual([]);
  });

  it("records read success directly and rejects an invalid handler output", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = invokingRegistry({ records });
    tools.register({
      ...definition("list_scenes", "read"),
      handler: async () => ({ ok: true, value: { value: 42 } as unknown as { value: string } }),
    });

    await expect(tools.invoke("list_scenes", { projectId: "project-1" }, request))
      .resolves.toMatchObject({ ok: false, error: { code: "internal" } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ tool: "list_scenes", outcome: "error", errorCode: "internal" });
  });

  it("does not report write success when no journal owns its invocation", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = invokingRegistry({ owned: false, records });
    tools.register(definition("save_file", "write"));

    await expect(tools.invoke("save_file", { projectId: "project-1" }, request)).resolves.toMatchObject({
      ok: false,
      error: { code: "internal", message: expect.stringContaining("without durable journal audit ownership") },
    });
  });
});

describe("delete_scene approval flow", () => {
  const binding: GrantBinding = {
    tool: "delete_scene",
    projectId: "project-1" as ProjectId,
    target: "scene-1",
    expectedRevision: 3,
    planDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ContentHash,
    targetHashes: {
      ["index.html" as RelPath]: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ContentHash,
    },
  };
  const context = (era: "modern" | "legacy") => ({
    actor: "agent" as const,
    era,
    protocolVersion: "2025-06-18",
    grantId: null,
    credentialId: null,
    invocationId: "invoke-1",
    writeInvocation: { toolAudit: null },
    requestInput: async (input: ConstructorParameters<typeof InputRequiredSignal>[0]): Promise<never> => {
      throw new InputRequiredSignal(input);
    },
  });
  const approvals = { request: async () => "request-1" };

  it("returns actionable approval_required details for legacy", async () => {
    await expect(requestSceneDeletionApproval(approvals, context("legacy"), binding, "scene-1"))
      .resolves.toMatchObject({
        ok: false,
        error: { code: "approval_required", details: { requestId: "request-1" }, message: expect.stringContaining("grantId") },
      });
  });

  it("raises modern input-required with requestState bound to the approval request", async () => {
    await expect(requestSceneDeletionApproval(approvals, context("modern"), binding, "scene-1"))
      .rejects.toMatchObject({
        name: "InputRequiredSignal",
        request: { requestState: "request-1", schema: { required: ["grantId"] } },
      });
  });
});

describe("complete tool descriptor contract", () => {
  it("locks all ten descriptors, legacy visibility, schema identity and deterministic order", () => {
    const tools = registry();
    registerVidcomTools(tools, null as unknown as VidcomToolDependencies);
    const modern = tools.list("modern");
    const legacy = tools.list("legacy");

    expect(legacy.map((tool) => tool.name)).toEqual(modern.map((tool) => tool.name));
    expect(modern.every((tool) => tool.inputSchema && tool.outputSchema)).toBe(true);
    expect(modern.map((tool) => ({
      name: tool.name,
      title: tool.title,
      level: tool.level,
      description: tool.description,
      annotations: tool.annotations,
    })))
      .toMatchInlineSnapshot(`
        [
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Create one scene source, mount it in the entry composition, and create its narration sidecar atomically. Requires the current entry-file expectedContentHash; stale or missing preconditions do not write.",
            "level": "write",
            "name": "create_scene",
            "title": "Create a scene",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Delete one allowlisted, unreferenced project-relative source after exact content-hash planning and approval. Rejects protected or composition-referenced files; publishes a verified backup and returns deleted path, revision envelope, and backupId.",
            "level": "destructive",
            "name": "delete_file",
            "title": "Delete an unreferenced source file",
          },
          {
            "annotations": {
              "destructiveHint": true,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Plan and delete one scene atomically, including its mount, unique source, narration, preview settings, verified backup, and root duration. Requires expectedRevision and an issued grantId; without one, creates an approval request and returns input-required/approval_required for retry.",
            "level": "destructive",
            "name": "delete_scene",
            "title": "Delete a scene",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read the bounded project, compact scenes, file hashes, entity/project revisions, diagnostics, preview settings, and recovery gate needed to plan a safe next edit.",
            "level": "read",
            "name": "get_project_context",
            "title": "Get project editing context",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "List available VidCom projects with dimensions, duration, current project revision, and write-recovery status. Use projectId from this result for project-scoped tools.",
            "level": "read",
            "name": "list_projects",
            "title": "List VidCom projects",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "List compact scene timing, source hash, narration-stale state, current project revision, and recovery gate without loading the full project context.",
            "level": "read",
            "name": "list_scenes",
            "title": "List project scenes",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Read one allowlisted project-relative composition source with its content hash and recovery gate. Rejects paths outside the project, disallowed assets, and files over the source-size limit.",
            "level": "read",
            "name": "read_composition",
            "title": "Read composition source",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Save one allowlisted project-relative text/composition file with expectedContentHash. Protected project metadata and oversized source are rejected; returns the new content hash and write envelope.",
            "level": "write",
            "name": "save_file",
            "title": "Save composition source",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Update a scene start, duration, or track index using the current entry-file expectedContentHash. Returns the updated compact scene, project, hashes, revisions, and diagnostics; invalid timing or stale hashes do not write.",
            "level": "write",
            "name": "set_scene_timing",
            "title": "Set scene timing",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Update one text element with the source file expectedContentHash. If the scene has narration, marks its sidecar stale in the same revision and returns narrationStale=true; it does not run TTS.",
            "level": "write",
            "name": "set_text",
            "title": "Set scene text",
          },
        ]
      `);
  });
});
