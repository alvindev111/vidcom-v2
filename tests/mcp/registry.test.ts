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

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
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
    writeInvocation: { origin: TEST_ORIGIN, toolAudit: null },
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
            "description": "Use when a HyperFrames folder already sits in the workspace unowned and needs a VidCom identity before it can be edited. Do not use for a folder outside the workspace, for a project that already has vidcom.json, or to create a project from nothing. Preconditions: slug is the folder name directly inside the active workspace, and that folder must contain hyperframes.json but no vidcom.json. Side effects: writes vidcom.json with a new projectId, seeds preview settings, and registers the project in one journaled bootstrap write. Errors/recovery: project_not_found means no such folder; write_conflict means it is already adopted; composition_parse_error means its index.html must be fixed before adoption.",
            "level": "write",
            "name": "adopt_project",
            "title": "Adopt a workspace folder",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when a render, snapshot or narration job you queued is no longer wanted and should stop before it finishes. Do not use to delete a finished artifact, and do not treat it as proof the work stopped. Preconditions: jobId comes from the tool that queued the work. Side effects: records a cooperative cancellation request; a job already succeeded, partial, failed or cancelled is left untouched and returns requested=false. Errors/recovery: not_found means the jobId is unknown; after requested=true keep polling get_job_status until it reports the cancelled outcome, because cancellation is not instant.",
            "level": "job",
            "name": "cancel_job",
            "title": "Cancel a background job",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when starting a new video from nothing, before any other project-scoped tool can be called. Do not use to re-create an existing project, to adopt a folder that already holds a composition, or to choose where the project is stored. Preconditions: name must produce a slug of letters, digits and hyphens; presetId is vertical-shorts, horizontal-youtube, or custom, and only custom accepts width, height and fps. Side effects: creates the project directory inside the active workspace with vidcom.json, hyperframes.json, preview-settings.json and an index.html root composition, as one journaled lifecycle write. Errors/recovery: fix schema_invalid on the name or preset fields; write_conflict means that slug is taken, so choose another name; storage_unavailable means no workspace is active, which only the UI or CLI can fix.",
            "level": "write",
            "name": "create_project",
            "title": "Create a VidCom project",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when adding one new mounted story beat with a source file and narration sidecar. Do not use to edit an existing scene, save an arbitrary source file, or add a beat whose narrative role and handoff are not yet defined. Preconditions: entry-file expectedContentHash must be the current entry-composition hash from get_project_context or read_composition; before calling, the storyboard names this beat's role, viewer experience, meaningful visual change, multi-phase choreography, and transition. Side effects: atomically creates the scene source and narration, updates the entry composition and root duration, and commits one revision. Errors/recovery: on write_conflict refresh context and re-plan; on recovery_required stop writes and recover; committed_response_error means the mutation committed, so do not retry it.",
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
            "description": "Use when permanently removing one entire project directory with a verified backup. Do not use to remove a single scene or file, to archive a project, or without the user asking for deletion in those words. Preconditions: projectId comes from list_projects, confirmed must be true, and omitting grantId creates an approval request to retry once with the issued grantId. Side effects: after approval, verifies a full backup, quarantines and removes the directory, consumes the grant, and commits one destructive lifecycle revision returning backupId. Errors/recovery: write_conflict means a running job or a file that changed after approval, so re-plan; backup_failed means nothing was deleted; request new approval after approval_invalid or approval_expired; recovery_required means the deletion is half-applied and must be recovered before anything else.",
            "level": "destructive",
            "name": "delete_project",
            "title": "Delete a project",
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
            "description": "Use when you need to poll a jobId returned by start_tts, start_snapshot, or start_render until it reaches a terminal outcome. Do not use to list jobs or to cancel one. Preconditions: jobId comes from the tool that queued the work. Side effects: read-only. Errors/recovery: wait pollAfterMs before the next poll and stop as soon as outcome is non-null — outcome, not status, is the terminal signal, and partial is one of its values (succeeded, partial, failed, cancelled), so a loop that waits only for succeeded polls forever. On failed, fix error.code before a deliberate resubmission.",
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
            "description": "Use when you need one scene's authored narration cues, their offsets and their synthesis staleness before writing cues or calling start_tts. Do not use to read composition source or to list scenes. Preconditions: projectId comes from list_projects and sceneId comes from list_scenes. Side effects: read-only; a scene with no sidecar returns an empty cue list and a null contentHash instead of an error. Errors/recovery: project_invalid means the sidecar is corrupt and must be replaced with replace_narration_cues; carry contentHash into the next cue write as its precondition.",
            "level": "read",
            "name": "get_narration_cues",
            "title": "Read scene narration cues",
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
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use when a render job has succeeded and you need the produced file's path, size, hash and media type to report or open it. Do not use to poll progress, to fetch the video bytes through this tool, or for snapshot jobs. Preconditions: jobId comes from start_render and get_job_status must already report succeeded or partial. Side effects: read-only; the artifact stays where the render wrote it. Errors/recovery: precondition_required means the job has not finished, so keep polling get_job_status; not_found means the job is not a render or its artifact is gone, so render again; a partial outcome means the file exists but the render reported warnings worth repeating.",
            "level": "read",
            "name": "get_render_output",
            "title": "Locate a finished render",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when a track already inside the project should become reusable by every project on this machine, with the licence it is allowed under recorded alongside it. Do not use to attach music to a project — that is install_bgm — and do not use for a file outside the project. Preconditions: projectId comes from list_projects and path is a project-relative mp3, wav, ogg or m4a as listed by list_project_assets; license.kind must be stated, and unknown is the honest value when nobody knows. Side effects: copies the bytes into the machine's BGM library and appends one ledger entry; the library is content-addressed, so importing the same bytes twice returns alreadyPresent=true and adds nothing. Errors/recovery: no_file means the path is not in the project; unsupported_media means the extension or the duration could not be read, so re-encode it; asset_not_allowed means the path is outside the project's asset allowlist.",
            "level": "write",
            "name": "import_bgm",
            "title": "Import a track into the BGM library",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when starting any VidCom MCP session: attempt this once before planning video work to install or refresh the workspace instructions and native skill router for the active host, and use it again when repairing that kit later. Read the installed AGENTS.md or CLAUDE.md and vidcom/SKILL.md before choosing a workflow. Do not use it to install both hosts implicitly, overwrite foreign/newer files, loop until ready, or block video work on manual_merge. Preconditions: install requires non-empty unique hosts; link is Claude-only; replace requires one manifest path and its current expectedContentHash. Side effects: writes one journaled workspace batch, or records an audited no-change when everything selected is pristine. Errors/recovery: when a foreign main file leaves the host degraded, read AGENTS.vidcom.md or CLAUDE.vidcom.md and the installed router directly, then proceed; re-read hashes after write_conflict and never invent a Codex import line.",
            "level": "write",
            "name": "install_agent_kit",
            "title": "Install the VidCom agent kit",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": true,
              "readOnlyHint": false,
            },
            "description": "Use when adding background music, which is the default for every video after its composition has a duration unless the user explicitly requests no music or silence is editorially required: renders a built-in bed, copies a shipped or imported track, or downloads the exact provider result and freezes it locally before attaching it. Do not use to change only volume or to detach music — that is set_preview_settings — and do not use to add narration or a sound effect. Preconditions: projectId and expectedRevision come from get_project_context; pass exactly one offline source from list_bgm_beds or providerTrack from search_bgm; verify the provider result's source and attribution before publishing; omit seconds to match the project duration. Side effects: provider music is first frozen in the machine library with its licence and provenance; then preview-assets/bgm/<name> is written and one revision sets bgm.enabled, track, volume and loop. Re-installing the same name is rejected rather than silently replaced. Errors/recovery: no_composition means the project has no duration yet, so pass seconds; write_conflict means expectedRevision is stale, so re-read get_project_context; storage_unavailable means this daemon cannot stage assets.",
            "level": "write",
            "name": "install_bgm",
            "title": "Install background music",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when a composition needs GSAP, Anime.js, Motion One, Lottie, or Three.js before referencing it in source; GSAP is the default for the multi-phase choreography required by story scenes. Do not use to add a CDN script tag, install an arbitrary npm package, write the composition markup itself, or substitute a library install for an actual motion map. Preconditions: projectId comes from list_projects; the library version is pinned by the studio and is not caller-selectable. Side effects: copies the pinned library into assets/vendor/ as one atomic mutation and commits one revision; re-running returns already_installed without a write. Errors/recovery: returns the paste-ready scriptTag and entry path to use; on write_conflict re-read and retry; storage_unavailable means the studio install is incomplete, so report it instead of falling back to a CDN.",
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
            "description": "Use when choosing background music, before install_bgm, to see the built-in beds and the tracks this machine has imported. Do not use to read a project's current music; get_project_context returns previewSettings.bgm. Preconditions: none; the built-in beds are always available offline and need no credential. Side effects: read-only; nothing is synthesized or written until install_bgm. Errors/recovery: an empty library is normal on a fresh install — pick a bed id instead; each library entry carries the licence it was imported under, and license.kind=unknown means nobody recorded one.",
            "level": "read",
            "name": "list_bgm_beds",
            "title": "List background music options",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use when choosing a video's look and the user and brand kit provide no explicit color direction; filter by mood or category when the brief implies one. Do not use a preset to replace colors explicitly supplied by the user or brand; custom direction always wins. Preconditions: none; every entry includes semantic color roles, controlled moods, harmony, choose/avoid guidance, and its source palette URL and swatches. Side effects: read-only; to apply one result atomically, call set_preview_settings with patch.theme.paletteId set to its id. Errors/recovery: an omitted category returns the complete catalog; defaultPaletteId is the deterministic fallback when no palette better matches the brief.",
            "level": "read",
            "name": "list_color_palettes",
            "title": "List standardized video palettes",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": false,
              "readOnlyHint": true,
            },
            "description": "Use when you need to discover the audio, image, video and font files that exist in the project, including one a person just copied into it by hand. Do not use to read composition source, to list scenes, or to browse anything outside this project. Preconditions: projectId comes from list_projects; pass directory to narrow to one project-relative folder such as preview-assets/bgm or assets. Side effects: read-only; nothing is written and no revision is created. Errors/recovery: path_invalid means the directory is not project-relative; truncated=true means only the first page is listed, so narrow with directory; referencedByPreviewSettings=true marks the track preview settings already point at.",
            "level": "read",
            "name": "list_project_assets",
            "title": "List project media assets",
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
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when correcting the text, voice or offset of exactly one existing cue while its siblings keep their synthesis state. Do not use to add or remove cues, which replace_narration_cues owns, and do not use to synthesize audio. Preconditions: projectId, sceneId, cueId and expectedContentHash come from get_narration_cues, and at least one of text, voice or offsetSeconds must be present. Side effects: rewrites the sidecar as one journaled write and commits one revision; changing text or voice marks only that cue stale, while an offset change keeps its audio valid. Errors/recovery: not_found means that cueId is gone; write_conflict means the sidecar changed, so re-read it; re-run start_tts for cues whose staleSince is set.",
            "level": "write",
            "name": "patch_narration_cue",
            "title": "Update one narration cue",
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
            "description": "Use when the licence of a shipped BGM track has been established and should be recorded, replacing the catalogue's unknown. Do not use to guess a licence, and do not use for a library entry — an import records its own licence. Preconditions: trackId comes from list_bgm_beds; license.kind must be the licence that was actually established, and holder plus url are required by attribution licences such as cc-by. Side effects: writes one entry into this machine's BGM ledger; every project on this install then reports that licence instead of unknown. Errors/recovery: not_found means the trackId is not a shipped track; recording again replaces the previous answer rather than failing.",
            "level": "write",
            "name": "record_bgm_license",
            "title": "Record a shipped track's licence",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when the project's title and folder slug must change together. Do not use to move a project between workspaces, to change composition content, or while one of its jobs is running. Preconditions: projectId comes from list_projects and name must produce a valid slug. Side effects: renames the project directory and updates its registration in one journaled lifecycle write; every project-relative path stays valid. Errors/recovery: schema_invalid means the name yields no slug; write_conflict means the target slug exists or a render, snapshot or narration job is running, so wait for get_job_status to report a terminal outcome and retry.",
            "level": "write",
            "name": "rename_project",
            "title": "Rename a project",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when writing or rewriting the complete spoken script of one scene before start_tts. Do not use to edit a single cue, to change on-screen text, or to synthesize audio. Preconditions: projectId and sceneId come from project context, cueIds must be unique, and expectedContentHash comes from get_narration_cues — null when that scene has no sidecar yet. Side effects: rewrites narration/<sceneId>.json as one journaled write, resets synthesis metadata for every cue, and commits one project revision; existing audio becomes stale. Errors/recovery: write_conflict means the sidecar changed, so re-read get_narration_cues; schema_invalid on cues means duplicate cueIds; run start_tts afterwards to produce audio again.",
            "level": "write",
            "name": "replace_narration_cues",
            "title": "Replace scene narration cues",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when replacing the complete content of one allowlisted project-relative text or composition source, including authored story choreography. Do not use for binary assets, oversized content, targeted text edits better handled by set_text, or a story scene whose only motion is fade, gentle rise/drop, or repeated opacity-plus-translate. Protected project metadata is rejected. Preconditions: path and expectedContentHash come from read_composition or current project context; the hash is for that exact file. A story scene source must implement setup, development, payoff and hold with motion that reveals meaning or changes visual state. Side effects: atomically replaces that source file, returns its new content hash, and commits one revision. Errors/recovery: correct path or size errors; on write_conflict re-read and re-plan; on recovery_required recover first; never retry a committed_response_error mutation.",
            "level": "write",
            "name": "save_file",
            "title": "Save composition source",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": true,
              "openWorldHint": true,
              "readOnlyHint": true,
            },
            "description": "Use when the built-in beds are not expressive enough and you need openly licensed music matched to a mood before install_bgm. Do not use after choosing a track, to fetch arbitrary URLs, or to assume a search result is publication clearance; verify its source link and attribution. Preconditions: describe the intended mood in plain language; results are restricted to CC0, public-domain, or CC BY sources and vocal-tagged tracks are excluded. Side effects: calls Openverse and ccMixter but writes nothing; provider failures are isolated and offlineFallbackAvailable remains true. Errors/recovery: unavailable or empty providers are reported in the output; fall back to list_bgm_beds when every remote source is unavailable.",
            "level": "read",
            "name": "search_bgm",
            "title": "Search open background music",
          },
          {
            "annotations": {
              "destructiveHint": false,
              "idempotentHint": false,
              "openWorldHint": false,
              "readOnlyHint": false,
            },
            "description": "Use when applying a bundled color palette by theme.paletteId, changing individual tone or theme colors, styling subtitles, setting per-scene sounds, or attaching background music already in the project. Do not use to edit composition source, to upload bytes, or to change scene timing. Preconditions: projectId and expectedRevision come from get_project_context; a bgm.track path must name an existing mp3, wav, ogg or m4a asset listed by list_project_assets, and setting bgm.track to null detaches the music. Side effects: merges the patch into preview-settings.json as one journaled entity mutation, returning the complete settings and their new revision; a palette id applies all semantic colors atomically, while an individual color override clears the preset id. Errors/recovery: no_file or unsupported_media means the track is missing or not audio, so run list_project_assets; write_conflict means expectedRevision is stale, so re-read get_project_context; never retry a committed_response_error mutation.",
            "level": "write",
            "name": "set_preview_settings",
            "title": "Patch preview settings",
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
            "description": "Use when the validated, visually inspected project is ready for one MP4 render, every story beat has meaningful multi-phase motion, and authored Unicode text has verified project-local font coverage. Do not use before validate_project and start_snapshot, to wait synchronously for completion, or when story scenes rely only on fade, gentle rise/drop, or repeated opacity-plus-translate entrances. Preconditions: projectId comes from list_projects and expectedSourceRevision must equal the computedAtSourceRevision returned by validate_project for the exact inspected generation; optional idempotencyKey must identify this exact revision, and the reviewed storyboard plus scene sources must show a value-first story spine and setup/development/payoff/hold choreography. Side effects: re-checks the exact source revision, diagnostics, encoding, font coverage and render lint before enqueueing one render job; it returns immediately without publishing an artifact yet. Errors/recovery: write_conflict means the project changed after review, so re-read, revalidate and inspect the new revision; poll get_job_status after pollAfterMs; fix stable gate errors before retrying and report warnings, outcome, and cleanupPending honestly.",
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
            "description": "Use when creating midpoint snapshots for visual inspection before final render. Do not use as a substitute for validate_project or to wait synchronously for every image. Preconditions: projectId comes from list_projects, optional idempotencyKey must identify this exact request, and authored Unicode text must pass the same encoding/font gate as render. Side effects: re-checks encoding/font coverage, enqueues one snapshot job, and returns immediately without publishing frames yet. Errors/recovery: poll get_job_status after pollAfterMs; report a partial outcome and its missingSceneIds, then retry deliberately after fixing the cause.",
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
            "description": "Use when validating a project after an edit and before snapshot or render, including UTF-8 decoding and exact project-local font glyph coverage for authored Unicode text. Do not use to mutate source or to inspect rendered pixels. Preconditions: projectId comes from list_projects. Side effects: computes diagnostics and refreshes only the derived diagnostics projection; source revision is unchanged. Errors/recovery: fix every error diagnostic before continuing; text-encoding-invalid, font-file-invalid, and font-glyph-missing block snapshot/render, while font-coverage-unverified means vendor an inspectable font instead of trusting machine fallback. no-composition is informational for an empty project.",
            "level": "read",
            "name": "validate_project",
            "title": "Validate a VidCom project",
          },
        ]
      `);
  });
});
