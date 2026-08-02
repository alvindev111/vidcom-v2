import { describe, expect, it } from "vitest";

import type { Actor, ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  err,
  ok,
  ToolAuditService,
  type AbsolutePath,
  type CompositionModel,
  type ProjectRef,
  type MutationRequest,
  type ResolvedPath,
  type ToolAuditEntry,
  type WriteInvocation,
} from "@vidcom/core";
import {
  registerVidcomTools,
  saveFileTool,
  setSceneTimingTool,
  ToolRegistry,
  type VidcomToolDependencies,
  type WriteToolDependencies,
} from "@vidcom/mcp";

const projectId = "project-tools" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "project-tools",
  root: "/workspace/project-tools" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const digest = (digit: string) => `sha256:${digit.repeat(64)}` as ContentHash;
const request = {
  era: "modern" as const,
  protocolVersion: "2025-06-18",
  credentialId: "credential-1",
  requestInput: async (): Promise<never> => { throw new Error("input not expected"); },
};

function audit(records: ToolAuditEntry[], owned: boolean): ToolAuditService {
  return new ToolAuditService(
    { record: async (entry) => { records.push(entry); } },
    { now: () => new Date("2026-08-02T00:00:00.000Z") },
    { warn: () => undefined, error: () => undefined },
    { increment: () => undefined, observeMilliseconds: () => undefined },
    { isJournalOwned: async () => owned },
  );
}

function registry(records: ToolAuditEntry[], owned = false): ToolRegistry {
  let invocation = 0;
  return new ToolRegistry({
    audit: audit(records, owned),
    approvals: { request: async () => "request-1" },
  }, {
    newInvocationId: () => `invocation-${++invocation}`,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
}

describe("all registered tool handlers", () => {
  it("runs a guarded case for every registered tool and keeps the case table in sync", async () => {
    const records: ToolAuditEntry[] = [];
    const tools = registry(records);
    const dependencies = {
      workspace: {
        listProjects: async () => [],
        readProjectRef: async () => null,
      },
      composition: {},
      journal: {},
      authority: {},
      clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
      hashContent: () => digest("f"),
      approvals: { request: async () => "request-1" },
    } as unknown as VidcomToolDependencies;
    registerVidcomTools(tools, dependencies);

    const cases: Record<string, unknown> = {
      list_projects: {},
      get_project_context: { projectId },
      list_scenes: { projectId },
      read_composition: { projectId, path: "index.html" },
      create_scene: { projectId, title: "Scene", expectedContentHash: digest("1") },
      set_scene_timing: { projectId, sceneId: "scene-1", duration: 4, expectedContentHash: digest("1") },
      set_text: {
        projectId, sceneId: "scene-1", file: "index.html", elementId: "title",
        text: "Hello", expectedContentHash: digest("1"),
      },
      save_file: { projectId, path: "compositions/scene-1.html", content: "<main />", expectedContentHash: digest("1") },
      delete_file: { projectId, path: "compositions/unused.html", expectedContentHash: digest("1") },
      delete_scene: { projectId, sceneId: "scene-1", expectedRevision: 0 },
    };
    expect(Object.keys(cases).sort()).toEqual(tools.list("modern").map((tool) => tool.name));

    for (const [name, input] of Object.entries(cases)) {
      const result = await tools.invoke(name, input, request);
      if (name === "list_projects") {
        expect(result).toEqual({ ok: true, value: { projects: [], diagnostics: [], nextCursor: null } });
      }
      else expect(result).toMatchObject({ ok: false, error: { code: "project_not_found" } });
    }
    expect(records).toHaveLength(10);
    expect(new Set(records.map((entry) => entry.tool))).toEqual(new Set(Object.keys(cases)));
  });
});

function writeDependencies(captured: Array<{ tool: string; invocation: WriteInvocation }>): WriteToolDependencies {
  const model: CompositionModel = {
    project: {
      id: projectId,
      slug: "project-tools",
      title: "Project tools",
      width: 1920,
      height: 1080,
      duration: 8,
      updatedAt: "2026-08-02T00:00:00.000Z",
      sceneCount: 1,
      revision: 0,
    },
    scenes: [{
      id: "scene-1",
      src: null,
      start: 0,
      duration: 4,
      trackIndex: 1,
      block: null,
      isTransition: false,
      media: [],
      script: [],
      narration: null,
      elements: [],
      unresolvedEffects: 0,
    }],
    rootTrack: null,
    diagnostics: [],
    sources: [{ path: "index.html" as RelPath, contentHash: digest("1"), byteSize: 16 }],
    references: [],
  };
  const mutate = async (mutation: MutationRequest, _actor: Actor, invocation?: WriteInvocation) => {
    captured.push({
      tool: mutation.kind === "file" && mutation.path === "index.html" ? "set_scene_timing" : "save_file",
      invocation: invocation!,
    });
    return ok({
      revision: captured.length,
      contentHash: digest(String(captured.length + 1)),
      diagnostics: [],
    });
  };
  return {
    workspace: {
      readProjectRef: async () => ref,
      resolve: async (_ref: ProjectRef, path: RelPath) => ok(path as unknown as ResolvedPath),
      readFile: async () => ({ content: "<main>before</main>", contentHash: digest("1") }),
    },
    composition: {
      parseProject: async () => model,
      applyOps: async () => ok("<main>after</main>"),
    },
    journal: {} as WriteToolDependencies["journal"],
    authority: {
      mutate,
      mutateComposite: async () => err({ code: "internal" as never, message: "not used" }),
    },
    clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
  } as unknown as WriteToolDependencies;
}

describe("write tool invocation forwarding", () => {
  it("passes Registry-created pending audits unchanged through save_file and set_scene_timing", async () => {
    const captured: Array<{ tool: string; invocation: WriteInvocation }> = [];
    const dependencies = writeDependencies(captured);
    const tools = registry([], true);
    tools.register(saveFileTool(dependencies));
    tools.register(setSceneTimingTool(dependencies));

    await expect(tools.invoke("save_file", {
      projectId,
      path: "compositions/scene-1.html",
      content: "<main>after</main>",
      expectedContentHash: digest("1"),
    }, request)).resolves.toMatchObject({ ok: true, value: { envelope: { projectRevision: 1 } } });
    await expect(tools.invoke("set_scene_timing", {
      projectId,
      sceneId: "scene-1",
      duration: 5,
      expectedContentHash: digest("1"),
    }, request)).resolves.toMatchObject({ ok: true, value: { envelope: { projectRevision: 2 } } });

    expect(captured.map((item) => item.tool)).toEqual(["save_file", "set_scene_timing"]);
    expect(captured[0]!.invocation.toolAudit).toMatchObject({
      tool: "save_file", invocationId: "invocation-1", projectId, credentialId: "credential-1",
    });
    expect(captured[1]!.invocation.toolAudit).toMatchObject({
      tool: "set_scene_timing", invocationId: "invocation-2", projectId, credentialId: "credential-1",
    });
  });
});
