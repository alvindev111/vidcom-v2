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
    expect(tool.projectIdOf({ limit: 20 })).toBeNull();
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

function invokingRegistry(options: {
  owned?: boolean;
  records: ToolAuditEntry[];
  revision?: number;
  now?: () => Date;
}): ToolRegistry {
  const audit = new ToolAuditService(
    { record: async (entry) => { options.records.push(entry); } },
    { now: () => new Date("2026-08-02T00:00:00.000Z") },
    { warn: () => undefined, error: () => undefined },
    { increment: () => undefined, observeMilliseconds: () => undefined },
    {
      isJournalOwned: async () => options.owned ?? false,
      latestRevision: async () => options.revision ?? null,
    },
  );
  return new ToolRegistry({
    audit,
    approvals: { request: null as unknown as ApprovalService["request"] },
  }, {
    newInvocationId: () => "invocation-registry-1",
    now: options.now ?? (() => new Date("2026-08-02T00:00:00.000Z")),
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
    expect(records[0]).toMatchObject({
      tool: "save_file",
      outcome: "error",
      errorCode: "schema_invalid",
      invokedAt: "2026-08-02T00:00:00.000Z",
      durationMs: 0,
      revisionBefore: null,
      revisionAfter: null,
    });
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
      revisionBefore: 0,
    });
    expect(records).toEqual([]);
  });

  it("records read success directly and rejects an invalid handler output", async () => {
    const records: ToolAuditEntry[] = [];
    let nowCall = 0;
    const tools = invokingRegistry({
      records,
      revision: 4,
      now: () => new Date(`2026-08-02T00:00:00.${nowCall++ === 0 ? "000" : "025"}Z`),
    });
    tools.register({
      ...definition("list_scenes", "read"),
      handler: async () => ({ ok: true, value: { value: 42 } as unknown as { value: string } }),
    });

    await expect(tools.invoke("list_scenes", { projectId: "project-1" }, request))
      .resolves.toMatchObject({ ok: false, error: { code: "internal" } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "list_scenes",
      outcome: "error",
      errorCode: "internal",
      invokedAt: "2026-08-02T00:00:00.000Z",
      durationMs: 25,
      revisionBefore: 4,
      revisionAfter: 4,
    });
  });

  it("reports malformed output as committed_response_error when the journal already owns success", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = invokingRegistry({ owned: true, records });
    tools.register({
      ...definition("save_file", "write"),
      handler: async () => ({
        ok: true,
        value: {
          value: 42,
          envelope: { projectRevision: 7, entityRevision: 3 },
        } as unknown as { value: string },
      }),
    });

    await expect(tools.invoke("save_file", { projectId: "project-1" }, request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "committed_response_error",
        message: expect.stringContaining("do not retry"),
        details: {
          committed: true,
          invocationId: "invocation-registry-1",
          projectRevision: 7,
          entityRevision: 3,
        },
      },
    });
    expect(records).toHaveLength(0);
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

  it("records exactly one caller-owned terminal audit before rethrowing modern input-required", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = invokingRegistry({ owned: false, records });
    tools.register({
      ...definition("delete_file", "destructive"),
      handler: async (context) => context.requestInput({
        message: "Approve deletion",
        requestState: "approval-request-1",
        schema: { type: "object", properties: {}, additionalProperties: false },
      }),
    });
    const inputRequest = {
      ...request,
      requestInput: async (input: ConstructorParameters<typeof InputRequiredSignal>[0]): Promise<never> => {
        throw new InputRequiredSignal(input);
      },
    };

    await expect(tools.invoke("delete_file", { projectId: "project-1" }, inputRequest))
      .rejects.toMatchObject({
        name: "InputRequiredSignal",
        request: { requestState: "approval-request-1" },
      });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tool: "delete_file",
      level: "destructive",
      outcome: "error",
      errorCode: "approval_required",
      credentialId: "credential-1",
      detail: {
        invocationId: "invocation-registry-1",
        requestState: "approval-request-1",
      },
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
  it("locks every descriptor, legacy visibility, schema identity and deterministic order", () => {
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
            "description": "Use when adding one new mounted scene with a source file and narration sidecar. Do not use to edit an existing scene or save an arbitrary source file. Preconditions: entry-file expectedContentHash must be the current entry-composition hash from get_project_context or read_composition. Side effects: atomically creates the scene source and narration, updates the entry composition and root duration, and commits one revision. Errors/recovery: on write_conflict refresh context and re-plan; on recovery_required stop writes and recover; committed_response_error means the mutation committed, so do not retry it.",
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
            "description": "Use when permanently removing one allowlisted, unreferenced project-relative source. Do not use for protected files, referenced sources, directories, or scene deletion. Preconditions: path and expectedContentHash come from read_composition or current project context; omit grantId to create an approval request, then retry once with the issued grantId. Side effects: after approval, atomically deletes the file, publishes a verified backup, consumes the grant, commits one destructive revision, and returns backupId with the revision envelope. Errors/recovery: keep the file on referenced_by_composition; re-read after write_conflict; request new approval after invalid or expired approval; recover on recovery_required; never retry committed_response_error.",
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
            "description": "Use when permanently removing one scene, its mount, unique source, narration, and preview settings with a verified backup. Do not use to hide, reorder, or edit a scene, or when shared references must remain. Preconditions: sceneId and expectedRevision come from current project context; omit grantId to create an approval request, then retry once with the issued grantId. Side effects: after approval, atomically deletes owned scene artifacts, updates root duration, publishes a backup, consumes the grant, and commits one destructive revision. Errors/recovery: refresh context after write_conflict; request new approval after approval_invalid or approval_expired; on recovery_required stop and recover; never retry committed_response_error.",
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
            "description": "Use when you need to poll a jobId returned by start_tts, start_snapshot, or start_render until it reaches a terminal outcome. Do not use to list jobs or to cancel one. Preconditions: jobId comes from the tool that queued the work. Side effects: read-only. Errors/recovery: wait pollAfterMs before the next poll; terminal outcome is explicit, including partial. On failed, fix error.code before a deliberate resubmission.",
            "level": "read",
            "name": "get_job_status",
            "title": "Get background job status",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use when planning an edit and you need compact scenes, canonical file hashes, revisions, diagnostics, preview settings, and the recovery gate. Do not use when you need full composition source; use read_composition instead. Preconditions: projectId comes from list_projects; this read has no mutation precondition. Side effects: read-only; no project files or revisions are changed. Errors/recovery: refresh list_projects after project_not_found; when recovery is blocked, stop mutations and complete the configured recovery flow before retrying.",
            "level": "read",
            "name": "get_project_context",
            "title": "Get project editing context",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when explicitly installing or repairing VidCom instructions and native skill routers for selected agent hosts. Do not use to install both hosts implicitly or overwrite foreign/newer files. Preconditions: install requires non-empty unique hosts; link is Claude-only; replace requires one manifest path and its current expectedContentHash. Side effects: writes one journaled workspace batch, or records an audited no-change when everything selected is pristine. Errors/recovery: follow installationState.recovery; re-read hashes after write_conflict and never invent a Codex import line.",
            "level": "write",
            "name": "install_agent_kit",
            "title": "Install the VidCom agent kit",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when a composition needs GSAP, Anime.js, Motion One, Lottie, or Three.js, before referencing it in source. Do not use to add a CDN script tag, to install an arbitrary npm package, or to write the composition markup itself. Preconditions: projectId comes from list_projects; the library version is pinned by the studio and is not caller-selectable. Side effects: copies the pinned library into assets/vendor/ as one atomic mutation and commits one revision; re-running returns already_installed without a write. Errors/recovery: returns the paste-ready scriptTag and entry path to use; on write_conflict re-read and retry; storage_unavailable means the studio install is incomplete, so report it instead of falling back to a CDN.",
            "level": "write",
            "name": "install_motion_library",
            "title": "Vendor a motion library",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use when you need to discover a VidCom projectId and its summary or write-recovery status. Do not use for scene details, source content, or mutation preconditions. Preconditions: none; use limit/cursor to page and a returned projectId for project-scoped tools. Side effects: read-only; no project files or revisions are changed. Errors/recovery: resolve workspace or project read errors before retrying; if recovery is blocked, complete the configured recovery flow before writes.",
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
            "description": "Use when you need compact scene timing, source hashes and availability diagnostics, narration state, project revision, and recovery status without full source content. Do not use for editing source text or reading complete composition markup. Preconditions: projectId comes from list_projects; this read has no mutation precondition. Side effects: read-only; no scene or revision is changed. Errors/recovery: refresh list_projects after project_not_found; when recovery is blocked, stop mutations and complete recovery before retrying.",
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
            "description": "Use when you need to discover which speech engines are installed on this machine and which voices each offers, before calling start_tts. Do not use to read a scene's existing narration text; use get_project_context. Preconditions: projectId comes from list_projects. Side effects: read-only; no project files, revisions or jobs are created. Errors/recovery: a provider with available=false reports why in unavailableReason — add an API key, install the sidecar, or install FFmpeg — and cannot be passed to start_tts until fixed. A voice offering only cpu in computeDevices means this machine has no usable GPU.",
            "level": "read",
            "name": "list_tts_voices",
            "title": "List narration voices",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use when you need one allowlisted project-relative composition source and its current content hash before a source write. Do not use for binary assets, external paths, or project-wide context. Preconditions: projectId comes from list_projects and path comes from project context or another trusted project-relative reference; no expected hash is required. Side effects: read-only; no source file or revision is changed. Errors/recovery: correct path_invalid, path_outside_project, asset_not_allowed, not_found, or source-size limit errors; if recovery is blocked, recover the project before writing.",
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
            "description": "Use when replacing the complete content of one allowlisted project-relative text or composition source. Do not use for binary assets, oversized content, or targeted text edits better handled by set_text. Protected project metadata is rejected. Preconditions: path and expectedContentHash come from read_composition or current project context; the hash is for that exact file. Side effects: atomically replaces that source file, returns its new content hash, and commits one revision. Errors/recovery: correct path or size errors; on write_conflict re-read and re-plan; on recovery_required recover first; never retry a committed_response_error mutation.",
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
            "description": "Use when changing at least one existing scene start, duration, or track index. Do not use for source text, scene creation, or an empty timing patch. Preconditions: sceneId and expectedContentHash must come from current project context; the hash is for the entry composition. Side effects: atomically updates scene timing and root duration and commits one revision. Errors/recovery: fix schema_invalid timing; on write_conflict refresh context and re-plan; on recovery_required recover first; never retry a committed_response_error mutation.",
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
            "description": "Use when replacing the text of one existing script element in an allowlisted scene source. Do not use to replace arbitrary markup, create elements, or run TTS. Preconditions: file, elementId, and expectedContentHash come from current project context or read_composition; the hash is for that source file. Side effects: atomically updates the source and, only when narration exists, marks its sidecar stale and returns narrationStale=true in the same revision; it does not run TTS. Errors/recovery: on not_found or write_conflict refresh the source and re-plan; on recovery_required recover first; never retry a committed_response_error mutation.",
            "level": "write",
            "name": "set_text",
            "title": "Set scene text",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when the validated, visually inspected project is ready for one MP4 render. Do not use before validate_project and start_snapshot, or to wait synchronously for video completion. Preconditions: projectId comes from list_projects and optional idempotencyKey must identify this exact request. Side effects: enqueues one render job and returns immediately without publishing an artifact yet. Errors/recovery: poll get_job_status after pollAfterMs; fix stable gate errors before retrying and report warnings, outcome, and cleanupPending honestly.",
            "level": "job",
            "name": "start_render",
            "title": "Start a video render",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when creating midpoint snapshots for visual inspection before final render. Do not use as a substitute for validate_project or to wait synchronously for every image. Preconditions: projectId comes from list_projects and optional idempotencyKey must identify this exact request. Side effects: enqueues one snapshot job and returns immediately without publishing frames yet. Errors/recovery: poll get_job_status after pollAfterMs; report a partial outcome and its missingSceneIds, then retry deliberately after fixing the cause.",
            "level": "job",
            "name": "start_snapshot",
            "title": "Start project snapshots",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when you need to turn the narration text already written on one or more scenes into audio files in the project. Do not use to write or change narration text, and do not use to render video. Preconditions: every scene must already have narration text; providerId and voiceId come from list_tts_voices; leave computeDevice unset for CPU and only pass gpu when the voice lists it. Side effects: enqueues one job, then writes narration/<sceneId>.wav plus its JSON sidecar and commits one project revision when the job succeeds. Cloud engines bill the account. Errors/recovery: this job is never retried automatically because synthesis costs money and its output is not reproducible — read the failed job's error code and resubmit deliberately. Poll with get_job_status; cancel through the job API stops the engine before anything is written.",
            "level": "job",
            "name": "start_tts",
            "title": "Generate scene narration audio",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use when validating a project after an edit and before snapshot or render. Do not use to mutate source or to inspect rendered pixels. Preconditions: projectId comes from list_projects. Side effects: computes diagnostics and refreshes only the derived diagnostics projection; source revision is unchanged. Errors/recovery: fix every error diagnostic before continuing; no-composition is an informational result for an empty project, not a tool failure.",
            "level": "read",
            "name": "validate_project",
            "title": "Validate a VidCom project",
          },
        ]
      `);
  });
});
