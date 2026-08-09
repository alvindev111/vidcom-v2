import {
  ActivateWorkspaceRequestSchema,
  CreateProjectRequestSchema,
  DeleteProjectRequestSchema,
  EnqueueRenderRequestSchema,
  EnqueueSnapshotRequestSchema,
  ErrorCode,
  InstallAgentKitInputSchema,
  JobParamsSchema,
  NarrationCueParamsSchema,
  PatchNarrationCueRequestSchema,
  ProjectParamsSchema,
  ProjectSlugParamsSchema,
  RecoveryEntryParamsSchema,
  RenameProjectRequestSchema,
  ReplaceRecoveryIdentityRequestSchema,
  ReplaceNarrationCuesRequestSchema,
  SceneTimingHttpRequestSchema,
  SceneParamsSchema,
  CreateSceneInputSchema,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  createScene,
  patchNarrationCue,
  readNarrationCues,
  readAsset,
  replaceNarrationCues,
  resolvePlatformPreset,
  setSceneTiming,
  type AbsolutePath,
  type AgentKitInstaller,
  type InstallAgentKitInput as CoreInstallAgentKitInput,
  type DiagnosticsService,
  type EntryId,
  type Job,
  type JobId,
  type JobStorePort,
  type ProcessTerminationProof,
  type ProjectLifecycle,
  type ProjectReadDependencies,
  type ProjectWriteDependencies,
  type Result,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

type BoundaryError = { code: ErrorCode; message: string; field?: string; details?: Record<string, unknown> };

export interface DeliveryLoopRouteDependencies {
  workspaceRoot: AbsolutePath;
  workspaceOverview(): Promise<unknown>;
  /**
   * Starts a project import and returns the job that owns it.
   *
   * Takes a browse selection token for the same reason activation does: a path
   * a client can type is a path any page can send, and the whole point of
   * browse is that the server only acts on directories it handed out itself.
   */
  startProjectImport?(input: { selectionToken: string; targetName?: string }):
    Promise<Result<{ jobId: string }, DomainError>>;
  /** Takes a browse selection token; no route accepts an absolute path from a client. */
  activateWorkspace(selectionToken: string): Promise<Result<{ workspaceRoot: AbsolutePath; reauthRequired: true }, DomainError>>;
  lifecycle: ProjectLifecycle;
  diagnostics: DiagnosticsService;
  agentKit: AgentKitInstaller;
  writes: ProjectWriteDependencies;
  reads: ProjectReadDependencies;
  jobs: JobStorePort;
  enqueueRender(input: {
    projectId: ProjectId; bestEffort?: boolean; renderPresetId?: string; idempotencyKey: string;
  }): Promise<Result<Job, DomainError>>;
  enqueueSnapshot(input: { projectId: ProjectId; idempotencyKey: string }): Promise<Result<Job, DomainError>>;
  replaceRecoveryIdentity(input: {
    entryId: EntryId; identity: Record<string, unknown>; expectedContentHash: ContentHash;
  }): Promise<Result<unknown, DomainError>>;
  mimeFromPath(path: string): string | null;
}

function fail(error: BoundaryError): never { throw new HttpBoundaryError(error); }
function valueOf<Value>(result: Result<Value, DomainError>): Value {
  return result.ok ? result.value : fail(result.error);
}
async function json(c: Context): Promise<unknown> {
  const mediaType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return fail({ code: ErrorCode.UnsupportedMedia, message: "content type must be application/json", field: "content-type" });
  }
  try { return await c.req.json(); }
  catch { return fail({ code: ErrorCode.SchemaInvalid, message: "request body is not valid JSON" }); }
}
function parse<Output>(schema: { safeParse(value: unknown): { success: true; data: Output } | { success: false } }, value: unknown, message: string): Output {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fail({ code: ErrorCode.SchemaInvalid, message });
}
function projectId(c: Context): ProjectId {
  return parse(ProjectParamsSchema, { id: c.req.param("id") }, "project id is invalid").id as ProjectId;
}
function jobId(c: Context): JobId {
  return parse(JobParamsSchema, { jobId: c.req.param("jobId") }, "job id is invalid").jobId as JobId;
}
async function requireJob(store: JobStorePort, id: JobId): Promise<Job> {
  const job = await store.get(id);
  return job ?? fail({ code: ErrorCode.NotFound, message: "job not found" });
}
type ByteRange = { kind: "absent" } | { kind: "unsatisfiable" } | { kind: "valid"; start: number; end: number };
function range(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return { kind: "absent" };
  const match = header.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || size === 0 || (match[1] === "" && match[2] === "")) return { kind: "unsatisfiable" };
  if (match[1] === "") {
    const suffixLength = BigInt(match[2]!);
    if (suffixLength === BigInt(0)) return { kind: "unsatisfiable" };
    return {
      kind: "valid",
      start: suffixLength >= BigInt(size) ? 0 : size - Number(suffixLength),
      end: size - 1,
    };
  }
  const start = BigInt(match[1]!);
  const end = match[2] === "" ? BigInt(size - 1) : BigInt(match[2]!);
  return start <= end && start < BigInt(size)
    ? { kind: "valid", start: Number(start), end: Number(end >= BigInt(size) ? size - 1 : end) }
    : { kind: "unsatisfiable" };
}

/** Shared strict render-enqueue boundary used by browser and bridge routes. */
export async function enqueueRenderResponse(
  dependencies: Pick<DeliveryLoopRouteDependencies, "enqueueRender">,
  c: Context,
): Promise<Response> {
  const input = parse(EnqueueRenderRequestSchema, await json(c), "render enqueue payload is invalid");
  const job = valueOf(await dependencies.enqueueRender({ projectId: projectId(c), ...input }));
  return c.json({ jobId: job.id }, 202);
}
function bytesResponse(c: Context, bytes: Uint8Array, hash: string, mime: string): Response {
  const etag = `"${hash}"`;
  const common = { "Accept-Ranges": "bytes", "Cache-Control": "must-revalidate", "Content-Type": mime, ETag: etag };
  if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers: common });
  const selected = range(c.req.header("Range"), bytes.byteLength);
  if (selected.kind === "unsatisfiable") return new Response(null, { status: 416, headers: {
    ...common, "Content-Length": "0", "Content-Range": `bytes */${bytes.byteLength}`,
  } });
  if (selected.kind === "absent") return new Response(Uint8Array.from(bytes).buffer, {
    headers: { ...common, "Content-Length": String(bytes.byteLength) },
  });
  const body = bytes.slice(selected.start, selected.end + 1);
  return new Response(Uint8Array.from(body).buffer, { status: 206, headers: {
    ...common,
    "Content-Length": String(body.byteLength),
    "Content-Range": `bytes ${selected.start}-${selected.end}/${bytes.byteLength}`,
  } });
}

/** Phase-O HTTP surface: transport validation only; every operation delegates to an application use case. */
export function createDeliveryLoopRoutes(dependencies: DeliveryLoopRouteDependencies): Hono {
  const routes = new Hono();
  routes.get("/v1/workspace", async (c) => c.json(await dependencies.workspaceOverview()));
  routes.put("/v1/workspace/active", async (c) => {
    const input = parse(ActivateWorkspaceRequestSchema, await json(c), "workspace activation payload is invalid");
    return c.json(valueOf(await dependencies.activateWorkspace(input.selectionToken)));
  });
  routes.post("/v1/projects/imports", async (c) => {
    if (!dependencies.startProjectImport) {
      throw new HttpBoundaryError({
        code: ErrorCode.NotFound,
        message: "this daemon does not accept project imports",
      });
    }
    const body = await json(c) as { sourceToken?: unknown; targetName?: unknown };
    if (typeof body.sourceToken !== "string" || body.sourceToken.length === 0) {
      throw new HttpBoundaryError({
        code: ErrorCode.SchemaInvalid,
        message: "sourceToken is required",
        field: "sourceToken",
      });
    }
    if (body.targetName !== undefined && typeof body.targetName !== "string") {
      throw new HttpBoundaryError({
        code: ErrorCode.SchemaInvalid,
        message: "targetName must be a string",
        field: "targetName",
      });
    }
    const started = valueOf(await dependencies.startProjectImport({
      selectionToken: body.sourceToken,
      ...(body.targetName === undefined ? {} : { targetName: body.targetName }),
    }));
    // 202, not 201: copying a project tree is not something to hold a request
    // open for, and the job id is what the client polls.
    return c.json(started, 202);
  });
  routes.post("/v1/projects", async (c) => {
    const input = parse(CreateProjectRequestSchema, await json(c), "project create payload is invalid");
    const preset = valueOf(resolvePlatformPreset(input));
    return c.json(valueOf(await dependencies.lifecycle.create({ name: input.name, preset, actor: "user" })), 201);
  });
  routes.post("/v1/projects/:slug/adopt", async (c) =>
    c.json(valueOf(await dependencies.lifecycle.adopt({
      slug: parse(ProjectSlugParamsSchema, { slug: c.req.param("slug") }, "project slug is invalid").slug,
      actor: "user",
    }))));
  routes.patch("/v1/projects/:id", async (c) => {
    const input = parse(RenameProjectRequestSchema, await json(c), "project rename payload is invalid");
    return c.json(valueOf(await dependencies.lifecycle.rename(
      { kind: "project", projectId: projectId(c) }, input.name, "user",
    )));
  });
  routes.delete("/v1/projects/:id", async (c) => {
    parse(DeleteProjectRequestSchema, await json(c), "project delete confirmation is invalid");
    return c.json(valueOf(await dependencies.lifecycle.remove(
      { kind: "project", projectId: projectId(c) }, { actor: "user", confirmed: true },
    )));
  });
  routes.post("/v1/projects/:id/renders", (c) => enqueueRenderResponse(dependencies, c));
  routes.post("/v1/projects/:id/snapshots", async (c) => {
    const input = parse(EnqueueSnapshotRequestSchema, await json(c), "snapshot enqueue payload is invalid");
    const job = valueOf(await dependencies.enqueueSnapshot({ projectId: projectId(c), ...input }));
    return c.json({ jobId: job.id }, 202);
  });
  routes.get("/v1/jobs/:jobId/termination-proof", async (c) => {
    const id = jobId(c);
    const job = await requireJob(dependencies.jobs, id);
    if (job.status !== "cancelled" && job.status !== "failed") fail({
      code: ErrorCode.WriteConflict, message: "termination proof is available only for cancelled or failed jobs",
    });
    const proof = dependencies.jobs.readTerminationProof
      ? await dependencies.jobs.readTerminationProof(id)
      : job.terminationProof ?? null;
    return proof
      ? c.json(proof satisfies ProcessTerminationProof)
      : fail({ code: ErrorCode.NotFound, message: "termination proof was not recorded" });
  });
  routes.get("/v1/projects/:id/diagnostics", async (c) =>
    c.json(valueOf(await dependencies.diagnostics.forProject(projectId(c)))));
  routes.post("/v1/projects/:id/scenes", async (c) => {
    const raw = await json(c);
    const candidate = raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...raw, projectId: c.req.param("id") }
      : { projectId: c.req.param("id") };
    const input = parse(CreateSceneInputSchema, candidate, "scene create payload is invalid");
    return c.json(valueOf(await createScene(dependencies.writes, {
      ...input, projectId: input.projectId as ProjectId, expectedContentHash: input.expectedContentHash as ContentHash | null,
    }, "user")), 201);
  });
  routes.patch("/v1/projects/:id/scenes/:sceneId/timing", async (c) => {
    const params = parse(SceneParamsSchema, c.req.param(), "scene path parameters are invalid");
    const input = parse(SceneTimingHttpRequestSchema, await json(c), "scene timing payload is invalid");
    return c.json(valueOf(await setSceneTiming(dependencies.writes, {
      projectId: params.id as ProjectId, sceneId: params.sceneId,
      timing: { start: input.start, duration: input.duration, trackIndex: input.trackIndex },
      ripple: input.ripple, extendRoot: input.extendRoot, expectedContentHash: input.expectedContentHash,
    }, "user")));
  });
  routes.get("/v1/projects/:id/scenes/:sceneId/narration-cues", async (c) => {
    const params = parse(SceneParamsSchema, c.req.param(), "scene path parameters are invalid");
    return c.json(valueOf(await readNarrationCues(dependencies.writes, {
      projectId: params.id as ProjectId, sceneId: params.sceneId,
    })));
  });
  routes.put("/v1/projects/:id/scenes/:sceneId/narration-cues", async (c) => {
    const params = parse(SceneParamsSchema, c.req.param(), "scene path parameters are invalid");
    const input = parse(ReplaceNarrationCuesRequestSchema, await json(c), "narration cue payload is invalid");
    return c.json(valueOf(await replaceNarrationCues(dependencies.writes, {
      projectId: params.id as ProjectId, sceneId: params.sceneId, cues: input.cues,
      expectedContentHash: input.expectedContentHash as ContentHash | null,
    }, "user")));
  });
  routes.patch("/v1/projects/:id/scenes/:sceneId/narration-cues/:cueId", async (c) => {
    const params = parse(NarrationCueParamsSchema, c.req.param(), "narration cue path parameters are invalid");
    const input = parse(PatchNarrationCueRequestSchema, await json(c), "narration cue patch is invalid");
    return c.json(valueOf(await patchNarrationCue(dependencies.writes, {
      projectId: params.id as ProjectId, sceneId: params.sceneId, cueId: params.cueId,
      patch: { text: input.text, voice: input.voice, offsetSeconds: input.offsetSeconds },
      expectedContentHash: input.expectedContentHash as ContentHash,
    }, "user")));
  });
  routes.get("/v1/recovery/entries/:entryId/diagnostics", async (c) => {
    const params = parse(RecoveryEntryParamsSchema, c.req.param(), "recovery entry id is invalid");
    return c.json(valueOf(await dependencies.diagnostics.forEntry(params.entryId as EntryId)));
  });
  routes.put("/v1/recovery/entries/:entryId/identity", async (c) => {
    const params = parse(RecoveryEntryParamsSchema, c.req.param(), "recovery entry id is invalid");
    const input = parse(
      ReplaceRecoveryIdentityRequestSchema,
      await json(c),
      "recovery identity payload is invalid",
    );
    return c.json(valueOf(await dependencies.replaceRecoveryIdentity({
      entryId: params.entryId as EntryId,
      identity: input.identity,
      expectedContentHash: input.expectedContentHash as ContentHash,
    })));
  });
  routes.patch("/v1/recovery/entries/:entryId", async (c) => {
    const params = parse(RecoveryEntryParamsSchema, c.req.param(), "recovery entry id is invalid");
    const input = parse(RenameProjectRequestSchema, await json(c), "recovery rename payload is invalid");
    return c.json(valueOf(await dependencies.lifecycle.rename(
      { kind: "entry", entryId: params.entryId as EntryId }, input.name, "user",
    )));
  });
  routes.delete("/v1/recovery/entries/:entryId", async (c) => {
    const params = parse(RecoveryEntryParamsSchema, c.req.param(), "recovery entry id is invalid");
    parse(DeleteProjectRequestSchema, await json(c), "recovery delete confirmation is invalid");
    return c.json(valueOf(await dependencies.lifecycle.remove(
      { kind: "entry", entryId: params.entryId as EntryId }, { actor: "user", confirmed: true },
    )));
  });
  routes.get("/v1/renders/:jobId/download", async (c) => {
    const job = await requireJob(dependencies.jobs, jobId(c));
    if (job.type !== "render" || (job.status !== "succeeded" && job.status !== "partial")) {
      fail({ code: ErrorCode.NotFound, message: "render artifact is not available" });
    }
    const path = (job.result as { artifactPath?: unknown } | null)?.artifactPath;
    if (typeof path !== "string") fail({ code: ErrorCode.NotFound, message: "render artifact is not available" });
    const mime = dependencies.mimeFromPath(path) ?? "video/mp4";
    const asset = valueOf(await readAsset(dependencies.reads, job.projectId, path as RelPath));
    return bytesResponse(c, asset.bytes, asset.contentHash, mime);
  });
  routes.post("/v1/agent-kit/install", async (c) => {
    const input = parse(InstallAgentKitInputSchema, await json(c), "agent-kit install payload is invalid");
    return c.json(valueOf(await dependencies.agentKit.apply(
      dependencies.workspaceRoot, input as CoreInstallAgentKitInput,
    )));
  });
  return routes;
}
