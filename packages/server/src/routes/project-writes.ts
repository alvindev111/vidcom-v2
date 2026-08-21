import {
  BgmLicenseSchema,
  ApplyFontRequestSchema,
  AuthoredElementIdSchema,
  ApplyFontResponseSchema,
  GenerateCaptionsRequestSchema,
  GenerateCaptionsResponseSchema,
  CreateEntryRequestSchema,
  CreateEntryResponseSchema,
  DeleteEntryRequestSchema,
  DeleteEntryResponseSchema,
  CompactTrackRequestSchema,
  DeleteScenesRequestSchema,
  DeleteScenesResponseSchema,
  ErrorCode,
  findShippedBgmTrack,
  ImportBgmInputSchema,
  InstallBgmInputSchema,
  InstallMotionLibraryRequestSchema,
  MAX_BGM_BYTES,
  MAX_SOURCE_BYTES,
  LegacySceneMutationRequestSchema,
  MountAssetRequestSchema,
  MountAssetResponseSchema,
  MoveScenesRequestSchema,
  PendingMountListResponseSchema,
  PendingMountParamsSchema,
  PendingMountSchema,
  RenameEntryRequestSchema,
  RenameEntryResponseSchema,
  PatchPreviewSettingsRequestSchema,
  PatchSceneScriptRequestSchema,
  PatchSceneTimingRequestSchema,
  ProjectParamsSchema,
  PrepareDeleteScenesRequestSchema,
  PrepareDeleteScenesResponseSchema,
  PrepareDeleteEntryResponseSchema,
  PutProjectFileRequestSchema,
  ReorderScenesRequestSchema,
  SearchBgmInputSchema,
  SearchBgmOutputSchema,
  SetElementPositionRequestSchema,
  SetElementPositionResponseSchema,
  SceneOrderMutationResponseSchema,
  TrackIndexParamsSchema,
  IdentifierSchema,
  UploadBgmRequestSchema,
  UploadAssetQuerySchema,
  UploadAssetResponseSchema,
  type ProjectId,
  type DomainError,
  type RelPath,
} from "@vidcom/contracts";
import {
  createScene,
  applyFont,
  generateCaptions,
  createEntry,
  compactTrack,
  deleteScenes,
  executeDeleteEntry,
  importBgm,
  installBgm,
  installMotionLibrary,
  listBgmSources,
  patchPreviewSettings,
  prepareDeleteScenes,
  prepareDeleteEntry,
  recordShippedBgmLicense,
  regenerateNarration,
  readSourceFile,
  reorderScenes,
  renameEntry,
  resolveProjectIdBySlug,
  saveSourceFile,
  searchBgmSources,
  setSceneScript,
  setSceneTiming,
  setElementPosition,
  moveScenes,
  mountAsset,
  uploadBgm,
  ingestAsset,
  type ApplyFontDependencies,
  type BgmDependencies,
  type GrantBinding,
  type IngestAssetDependencies,
  type EntryCrudDependencies,
  type MotionLibraryInstallDependencies,
  type PendingMountPort,
  type ProjectReadDependencies,
  type ProjectWriteDependencies,
  type Result,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";
import { requestBodyChunks } from "../request-stream";
import { studioWriteInvocation, type StudioRouteDependencies } from "./studio-session";

export interface ProjectWriteRouteDependencies extends ProjectWriteDependencies {
  reads: ProjectReadDependencies;
  /** Declared separately: the install use case narrows `authority` to the composite overload. */
  motionLibraries: MotionLibraryInstallDependencies["motionLibraries"];
  bgmSynth: BgmDependencies["bgmSynth"];
  bgmLibrary: BgmDependencies["bgmLibrary"];
  bgmProviders?: BgmDependencies["bgmProviders"];
  hashContent: BgmDependencies["hashContent"];
  approvals: {
    request(binding: GrantBinding, summary: string): Promise<string>;
    issue(requestId: string, approver: "ui"): Promise<Result<string, DomainError>>;
  };
  mimeFromPath(path: string): string | null;
  staging?: IngestAssetDependencies["staging"];
  sanitizer?: IngestAssetDependencies["sanitizer"];
  /** Full port: ingest only looks operations up, but §7.14b lists and abandons them. */
  pendingMount?: PendingMountPort;
  probe?: IngestAssetDependencies["probe"];
  styles?: ApplyFontDependencies["styles"];
}

/** Immutable audio: content-addressed on this install, so it can be cached hard. */
function audioResponse(c: Context, bytes: Uint8Array, mime: string): Response {
  return new Response(Uint8Array.from(bytes).buffer, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "none",
    },
  });
}

function fail(error: { code: ErrorCode; message: string; field?: string; details?: Record<string, unknown> }): never {
  throw new HttpBoundaryError(error);
}

function valueOf<Value>(result: { ok: true; value: Value } | { ok: false; error: Parameters<typeof fail>[0] }): Value {
  return result.ok ? result.value : fail(result.error);
}

function projectId(c: Context): ProjectId {
  const parsed = ProjectParamsSchema.safeParse({ id: c.req.param("id") });
  return parsed.success
    ? parsed.data.id as ProjectId
    : fail({ code: ErrorCode.SchemaInvalid, message: "project id is invalid", field: "id" });
}

function pendingMountStore(
  dependencies: ProjectWriteRouteDependencies,
): NonNullable<ProjectWriteRouteDependencies["pendingMount"]> {
  return dependencies.pendingMount
    ?? fail({ code: ErrorCode.StorageUnavailable, message: "pending mount services are unavailable" });
}

/** §7.14b: the operation is always read with the project in the path, never alone. */
function pendingMountParams(c: Context): { id: ProjectId; operationId: string } {
  const parsed = PendingMountParamsSchema.safeParse({ id: c.req.param("id"), operationId: c.req.param("operationId") });
  return parsed.success
    ? { id: parsed.data.id as ProjectId, operationId: parsed.data.operationId }
    : fail({ code: ErrorCode.SchemaInvalid, message: "pending mount operation id is invalid", field: "operationId" });
}

async function json(c: Context): Promise<unknown> {
  try { return await c.req.json(); }
  catch { return fail({ code: ErrorCode.SchemaInvalid, message: "request body is not valid JSON" }); }
}

function audioMagic(bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  return ascii(0, 3) === "ID3"
    || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    || (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE")
    || ascii(0, 4) === "OggS"
    || ascii(4, 8) === "ftyp";
}

function transcript(slug: string, prompt: string, result: { sceneId: string; start: number; duration: number }) {
  const { sceneId, start, duration } = result;
  return [
    { kind: "command" as const, text: "codex" },
    { kind: "accent" as const, text: `● Codex CLI · MCP server "hyperframes" (stdio) · workspace ${slug}` },
    { kind: "output" as const, text: "" },
    { kind: "output" as const, text: `> ${prompt}` },
    { kind: "output" as const, text: "" },
    { kind: "muted" as const, text: "· mcp hyperframes.list_compositions" },
    { kind: "muted" as const, text: `· mcp hyperframes.add_scene { id: "${sceneId}", start: ${start}, duration: ${duration} }` },
    { kind: "muted" as const, text: `· mcp hyperframes.tts { scene: "${sceneId}", voice: "af_heart" } → narration/${sceneId}.wav` },
    { kind: "muted" as const, text: "· mcp hyperframes.lint" },
    { kind: "accent" as const, text: `✓ ${sceneId} written to index.html — open the Video Scene tab to edit it` },
  ];
}

/** V1 project mutations and the two required legacy scene aliases. */
export function createProjectWriteRoutes(
  dependencies: ProjectWriteRouteDependencies,
  studio?: StudioRouteDependencies,
): Hono {
  const routes = new Hono();
  routes.post("/v1/projects/:id/assets", async (c) => {
    const query = Object.fromEntries(new URL(c.req.url).searchParams);
    const parsed = UploadAssetQuerySchema.safeParse(query);
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "asset upload query is invalid" });
    if (c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/octet-stream") {
      fail({ code: ErrorCode.UnsupportedMedia, message: "asset upload must use application/octet-stream" });
    }
    const body = c.req.raw.body;
    if (!body) fail({ code: ErrorCode.SchemaInvalid, message: "asset upload body is required" });
    const id = projectId(c);
    const invocation = studioWriteInvocation(studio, c, id, "Upload asset");
    if (!dependencies.staging || !dependencies.sanitizer || !dependencies.pendingMount || !dependencies.probe) {
      fail({ code: ErrorCode.StorageUnavailable, message: "asset upload services are unavailable" });
    }
    const uploaded = valueOf(await ingestAsset({
      ...dependencies,
      staging: dependencies.staging,
      sanitizer: dependencies.sanitizer,
      pendingMount: dependencies.pendingMount,
      probe: dependencies.probe,
    }, {
      projectId: id,
      kind: parsed.data.kind,
      filename: parsed.data.filename,
      expectedRevision: parsed.data.expectedRevision,
      stream: requestBodyChunks(c.req.raw),
      signal: c.req.raw.signal,
      ...(parsed.data.operationId === undefined ? {} : {
        pendingMount: {
          operationId: parsed.data.operationId,
          atSeconds: parsed.data.atSeconds!,
          trackIndex: parsed.data.trackIndex!,
        },
      }),
    }, "user", invocation.origin));
    return c.json(UploadAssetResponseSchema.parse({
      path: uploaded.path,
      renamedFrom: uploaded.renamedFrom,
      assetContentHash: uploaded.assetContentHash,
      metadata: uploaded.metadata,
      replayed: uploaded.replayed,
      revision: uploaded.revision,
      changeSeq: uploaded.envelope?.changeSeq ?? null,
    }), 201);
  });
  routes.post("/v1/projects/:id/assets/mount", async (c) => {
    const parsed = MountAssetRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "asset mount payload is invalid" });
    const id = projectId(c);
    if (!dependencies.pendingMount || !dependencies.probe) {
      fail({ code: ErrorCode.StorageUnavailable, message: "asset mount services are unavailable" });
    }
    const invocation = studioWriteInvocation(studio, c, id, "Mount asset");
    const mounted = valueOf(await mountAsset({
      ...dependencies,
      pendingMount: dependencies.pendingMount,
      probe: dependencies.probe,
      toolAudit: invocation.toolAudit,
    }, {
      projectId: id,
      ...parsed.data,
      ...("assetPath" in parsed.data ? { assetPath: parsed.data.assetPath as RelPath } : {}),
    } as Parameters<typeof mountAsset>[1], "user", invocation.origin));
    return c.json(MountAssetResponseSchema.parse({
      sceneId: mounted.sceneId,
      durationSeconds: mounted.durationSeconds,
      replayed: mounted.replayed,
      revision: mounted.revision,
      diagnostics: mounted.envelope?.diagnostics ?? [],
      changeSeq: mounted.envelope?.changeSeq ?? null,
    }), 201);
  });
  routes.get("/v1/projects/:id/pending-mounts", async (c) => {
    const id = projectId(c);
    const store = pendingMountStore(dependencies);
    return c.json(PendingMountListResponseSchema.parse({ items: await store.listPending(id) }));
  });
  routes.get("/v1/projects/:id/pending-mounts/:operationId", async (c) => {
    const params = pendingMountParams(c);
    const store = pendingMountStore(dependencies);
    const found = await store.lookup(params.id, params.operationId);
    // `expired` and `never-seen` stay distinct in the port but read the same over
    // HTTP: there is nothing left to resume either way, and a client that learns
    // an unknown ULID once existed learns nothing it can act on.
    if (found.state !== "active") {
      fail({ code: ErrorCode.NotFound, message: "there is no pending upload for that operation", field: "operationId" });
    }
    return c.json(PendingMountSchema.parse(found.record));
  });
  routes.delete("/v1/projects/:id/pending-mounts/:operationId", async (c) => {
    const params = pendingMountParams(c);
    const store = pendingMountStore(dependencies);
    try {
      await store.abandon(params.id, params.operationId, "abandoned by the studio");
    } catch (error) {
      // A lost abandon/close race is a conflict, not a server fault: the row is
      // already mounted, so the studio should re-read it rather than retry.
      const code = (error as { code?: ErrorCode }).code;
      if (code === undefined) throw error;
      fail({ code, message: (error as Error).message, field: "operationId" });
    }
    return c.body(null, 204);
  });
  routes.post("/v1/projects/:id/entries", async (c) => {
    const parsed = CreateEntryRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "entry creation payload is invalid" });
    const id = projectId(c);
    const created = valueOf(await createEntry(dependencies as EntryCrudDependencies, {
      projectId: id, ...parsed.data, path: parsed.data.path as RelPath,
    }, "user", studioWriteInvocation(studio, c, id, "Create entry")));
    return c.json(CreateEntryResponseSchema.parse({
      path: created.path, kind: created.kind, revision: created.envelope.projectRevision,
      diagnostics: created.envelope.diagnostics, changeSeq: created.envelope.changeSeq,
    }), 201);
  });
  routes.patch("/v1/projects/:id/entries", async (c) => {
    const parsed = RenameEntryRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "entry rename payload is invalid" });
    const id = projectId(c);
    const expected = "expectedContentHash" in parsed.data
      ? { kind: "file" as const, contentHash: parsed.data.expectedContentHash }
      : { kind: "folder" as const, treeDigest: parsed.data.expectedTreeDigest };
    const renamed = valueOf(await renameEntry(dependencies as EntryCrudDependencies, {
      projectId: id,
      from: parsed.data.from as RelPath,
      to: parsed.data.to as RelPath,
      expectedRevision: parsed.data.expectedRevision,
      expected: expected as Parameters<typeof renameEntry>[1]["expected"],
    }, "user", studioWriteInvocation(studio, c, id, "Rename entry")));
    return c.json(RenameEntryResponseSchema.parse({
      from: renamed.from, to: renamed.to, backupId: renamed.backupId,
      revision: renamed.envelope.projectRevision, diagnostics: renamed.envelope.diagnostics,
      changeSeq: renamed.envelope.changeSeq,
    }));
  });
  routes.post("/v1/projects/:id/entries/deletions", async (c) => {
    const parsed = DeleteEntryRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "entry deletion plan payload is invalid" });
    const id = projectId(c);
    studioWriteInvocation(studio, c, id, "Delete entry");
    const prepared = valueOf(await prepareDeleteEntry(dependencies as EntryCrudDependencies, {
      projectId: id, ...parsed.data, path: parsed.data.path as RelPath,
    }));
    const grantId = await dependencies.approvals.request(prepared.binding, `Delete ${prepared.plan.path}`);
    return c.json(PrepareDeleteEntryResponseSchema.parse({ plan: prepared.plan, grantId }));
  });
  routes.post("/v1/projects/:id/entries/deletions/:grantId", async (c) => {
    const parsed = DeleteEntryRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "entry deletion payload is invalid" });
    const grant = IdentifierSchema.safeParse(c.req.param("grantId"));
    if (!grant.success) fail({ code: ErrorCode.SchemaInvalid, message: "deletion grant id is invalid", field: "grantId" });
    const id = projectId(c);
    const invocation = studioWriteInvocation(studio, c, id, "Delete entry");
    const grantId = valueOf(await dependencies.approvals.issue(grant.data, "ui"));
    const deleted = valueOf(await executeDeleteEntry(dependencies as EntryCrudDependencies, {
      projectId: id, ...parsed.data, path: parsed.data.path as RelPath, grantId,
    }, "user", invocation));
    return c.json(DeleteEntryResponseSchema.parse({
      deleted: deleted.deleted, backupId: deleted.backupId, revision: deleted.envelope.projectRevision,
      diagnostics: deleted.envelope.diagnostics, changeSeq: deleted.envelope.changeSeq,
    }));
  });
  routes.post("/v1/projects/:id/scenes/:sceneId/captions", async (c) => {
    const parsed = GenerateCaptionsRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "caption payload is invalid" });
    const sceneId = IdentifierSchema.safeParse(c.req.param("sceneId"));
    if (!sceneId.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene id is invalid", field: "sceneId" });
    const id = projectId(c);
    const captions = valueOf(await generateCaptions(dependencies, {
      projectId: id,
      sceneId: sceneId.data,
      expectedContentHash: parsed.data.expectedContentHash as Parameters<typeof generateCaptions>[1]["expectedContentHash"],
    }, "user", studioWriteInvocation(studio, c, id, "Generate captions")));
    return c.json(GenerateCaptionsResponseSchema.parse({
      cues: captions.cues,
      timingSource: captions.timingSource,
      revision: captions.envelope.projectRevision,
      diagnostics: captions.envelope.diagnostics,
      changeSeq: captions.envelope.changeSeq,
    }));
  });
  routes.post("/v1/projects/:id/fonts/apply", async (c) => {
    const parsed = ApplyFontRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "font application payload is invalid" });
    const id = projectId(c);
    if (!dependencies.probe || !dependencies.styles) {
      fail({ code: ErrorCode.StorageUnavailable, message: "font application services are unavailable" });
    }
    const appliedResult = await applyFont({
      ...dependencies,
      probe: dependencies.probe,
      styles: dependencies.styles,
    }, {
      projectId: id,
      ...parsed.data,
      fontPath: parsed.data.fontPath as RelPath,
      fontContentHash: parsed.data.fontContentHash as Parameters<typeof applyFont>[1]["fontContentHash"],
      expectedContentHash: parsed.data.expectedContentHash as Parameters<typeof applyFont>[1]["expectedContentHash"],
    }, "user", studioWriteInvocation(studio, c, id, "Apply font"));
    if (!appliedResult.ok) {
      throw new HttpBoundaryError(
        appliedResult.error,
        appliedResult.error.code === ErrorCode.AssetNotAllowed ? 422 : undefined,
      );
    }
    const applied = appliedResult.value;
    return c.json(ApplyFontResponseSchema.parse({
      path: applied.path,
      family: applied.family,
      style: applied.style,
      revision: applied.envelope.projectRevision,
      diagnostics: applied.envelope.diagnostics,
      changeSeq: applied.envelope.changeSeq,
    }));
  });
  routes.put("/v1/projects/:id/files", async (c) => {
    const parsed = PutProjectFileRequestSchema.safeParse(await json(c));
    if (!parsed.success) {
      const oversized = parsed.error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "content");
      fail({
        code: oversized ? ErrorCode.TooLarge : ErrorCode.SchemaInvalid,
        message: oversized ? `source content exceeds ${MAX_SOURCE_BYTES} bytes` : "file write payload is invalid",
      });
    }
    const id = projectId(c);
    const saved = valueOf(await saveSourceFile(dependencies, {
      projectId: id,
      path: parsed.data.path as RelPath,
      content: parsed.data.content,
      expectedContentHash: parsed.data.expectedContentHash,
    }, "user", studioWriteInvocation(studio, c, id, "Edit source")));
    return c.json({
      file: { ...saved.file, content: parsed.data.content },
      revision: saved.envelope.projectRevision,
      diagnostics: saved.envelope.diagnostics,
      changeSeq: saved.envelope.changeSeq,
    });
  });
  routes.patch("/v1/projects/:id/preview-settings", async (c) => {
    const parsed = PatchPreviewSettingsRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "preview settings payload is invalid" });
    const id = projectId(c);
    return c.json(valueOf(await patchPreviewSettings(dependencies, {
      projectId: id, ...parsed.data,
    }, "user", studioWriteInvocation(studio, c, id, "Edit preview settings"))));
  });
  routes.post("/v1/projects/:id/assets/bgm", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const parsed = UploadBgmRequestSchema.safeParse({
      file: form?.get("file"), expectedRevision: form?.get("expectedRevision"),
    });
    if (!parsed.success) {
      const oversized = parsed.error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "file");
      const missingPrecondition = form?.get("expectedRevision") === null || form?.get("expectedRevision") === "";
      fail({
        code: oversized ? ErrorCode.TooLarge : missingPrecondition ? ErrorCode.PreconditionRequired : ErrorCode.SchemaInvalid,
        message: oversized
          ? `BGM file exceeds ${MAX_BGM_BYTES} bytes`
          : missingPrecondition ? "expectedRevision is required" : "BGM upload payload is invalid",
      });
    }
    const bytes = new Uint8Array(await parsed.data.file.arrayBuffer());
    if (!audioMagic(bytes)) fail({ code: ErrorCode.UnsupportedMedia, message: "BGM file signature is unsupported" });
    const id = projectId(c);
    return c.json(valueOf(await uploadBgm(dependencies, {
      projectId: id, name: parsed.data.file.name, bytes,
      expectedRevision: parsed.data.expectedRevision,
    }, "user", studioWriteInvocation(studio, c, id, "Upload background music"))));
  });
  // The built-in beds and this machine's library, in one read: a picker needs both
  // and a fresh install has only the first.
  routes.get("/v1/bgm", async (c) => c.json(await listBgmSources(dependencies)));
  routes.get("/v1/bgm/search", async (c) => {
    const rawLimit = c.req.query("limit");
    const parsed = SearchBgmInputSchema.safeParse({
      mood: c.req.query("mood"),
      ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
    });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "BGM search query is invalid", field: "mood" });
    return c.json(SearchBgmOutputSchema.parse(await searchBgmSources(dependencies, parsed.data)));
  });
  // Audition before installing: a picker that cannot play a track is a list of
  // filenames. Bytes, not a path — the shipped audio lives outside the project
  // and the library lives outside the workspace, so neither is reachable through
  // the project asset route.
  // Closing the licence gap is a machine-level fact, so it is recorded once here
  // rather than per project or by editing the shipped catalogue.
  routes.put("/v1/bgm/tracks/:trackId/license", async (c) => {
    const parsed = BgmLicenseSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "licence payload is invalid", field: "kind" });
    return c.json(valueOf(await recordShippedBgmLicense(dependencies, {
      trackId: c.req.param("trackId") ?? "",
      license: parsed.data,
    })));
  });
  routes.get("/v1/bgm/tracks/:trackId/audio", async (c) => {
    const track = findShippedBgmTrack(c.req.param("trackId") ?? "");
    if (!track) fail({ code: ErrorCode.NotFound, message: "unknown shipped track", field: "trackId" });
    const bytes = await dependencies.bgmLibrary.readShipped(track.filename);
    if (!bytes) {
      fail({ code: ErrorCode.NoFile, message: "this build ships the catalogue entry but not its audio" });
    }
    return audioResponse(c, bytes, dependencies.mimeFromPath(track.filename) ?? "audio/mpeg");
  });
  routes.get("/v1/bgm/library/:entryId/audio", async (c) => {
    const entryId = c.req.param("entryId") ?? "";
    const entry = (await dependencies.bgmLibrary.list()).find((candidate) => candidate.id === entryId);
    if (!entry) fail({ code: ErrorCode.NotFound, message: "unknown library entry", field: "entryId" });
    const bytes = await dependencies.bgmLibrary.read(entry.id);
    if (!bytes) fail({ code: ErrorCode.NoFile, message: "the entry is registered but its file is gone" });
    return audioResponse(c, bytes, dependencies.mimeFromPath(entry.name) ?? "audio/mpeg");
  });
  routes.post("/v1/projects/:id/bgm", async (c) => {
    const parsed = InstallBgmInputSchema.safeParse({ ...(await json(c) as object), projectId: c.req.param("id") });
    if (!parsed.success) {
      fail({ code: ErrorCode.SchemaInvalid, message: "BGM install payload is invalid", field: "bedId" });
    }
    const id = parsed.data.projectId as ProjectId;
    return c.json(valueOf(await installBgm(dependencies, {
      ...parsed.data,
      projectId: id,
    }, "user", studioWriteInvocation(studio, c, id, "Install background music"))));
  });
  routes.post("/v1/projects/:id/bgm/library", async (c) => {
    const parsed = ImportBgmInputSchema.safeParse({ ...(await json(c) as object), projectId: c.req.param("id") });
    if (!parsed.success) {
      fail({ code: ErrorCode.SchemaInvalid, message: "BGM import payload is invalid", field: "path" });
    }
    return c.json(valueOf(await importBgm(dependencies, {
      ...parsed.data,
      projectId: parsed.data.projectId as ProjectId,
    })), 201);
  });
  routes.post("/v1/projects/:id/motion-libraries", async (c) => {
    const parsed = InstallMotionLibraryRequestSchema.safeParse(await json(c));
    if (!parsed.success) {
      fail({ code: ErrorCode.SchemaInvalid, message: "motion library payload is invalid", field: "libraryId" });
    }
    const id = projectId(c);
    return c.json(valueOf(await installMotionLibrary(dependencies, {
      projectId: id, libraryId: parsed.data.libraryId,
    }, "user", studioWriteInvocation(studio, c, id, "Install motion library"))));
  });
  routes.patch("/v1/projects/:id/scenes/order", async (c) => {
    const parsed = ReorderScenesRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene order payload is invalid" });
    const id = projectId(c);
    const ordered = valueOf(await reorderScenes(dependencies, {
      projectId: id,
      ...parsed.data,
    }, "user", studioWriteInvocation(studio, c, id, "Reorder scene")));
    const file = valueOf(await readSourceFile(dependencies.reads, id, "index.html" as RelPath));
    return c.json(SceneOrderMutationResponseSchema.parse({
      changed: ordered.changed,
      changes: ordered.changes,
      file,
      revision: ordered.envelope?.projectRevision ?? ordered.project.revision,
      diagnostics: ordered.diagnostics,
      changeSeq: ordered.envelope?.changeSeq ?? null,
    }));
  });
  routes.post("/v1/projects/:id/tracks/:trackIndex/compact", async (c) => {
    const params = TrackIndexParamsSchema.safeParse({ id: c.req.param("id"), trackIndex: c.req.param("trackIndex") });
    if (!params.success) fail({ code: ErrorCode.SchemaInvalid, message: "track index is invalid", field: "trackIndex" });
    const parsed = CompactTrackRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "track compact payload is invalid" });
    const id = params.data.id as ProjectId;
    const compacted = valueOf(await compactTrack(dependencies, {
      projectId: id,
      trackIndex: params.data.trackIndex,
      ...parsed.data,
    }, "user", studioWriteInvocation(studio, c, id, "Compact track")));
    const file = valueOf(await readSourceFile(dependencies.reads, id, "index.html" as RelPath));
    return c.json(SceneOrderMutationResponseSchema.parse({
      changed: compacted.changed,
      changes: compacted.changes,
      file,
      revision: compacted.envelope?.projectRevision ?? compacted.project.revision,
      diagnostics: compacted.diagnostics,
      changeSeq: compacted.envelope?.changeSeq ?? null,
    }));
  });
  routes.post("/v1/projects/:id/scenes/move", async (c) => {
    const parsed = MoveScenesRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene move payload is invalid" });
    const id = projectId(c);
    const moved = valueOf(await moveScenes(dependencies, {
      projectId: id,
      ...parsed.data,
    }, "user", studioWriteInvocation(studio, c, id, `Move ${parsed.data.sceneIds.length} scenes`)));
    const file = valueOf(await readSourceFile(dependencies.reads, id, "index.html" as RelPath));
    return c.json(SceneOrderMutationResponseSchema.parse({
      changed: moved.changed,
      changes: moved.changes,
      file,
      revision: moved.envelope?.projectRevision ?? moved.project.revision,
      diagnostics: moved.diagnostics,
      changeSeq: moved.envelope?.changeSeq ?? null,
    }));
  });
  routes.post("/v1/projects/:id/scenes/deletions", async (c) => {
    const parsed = PrepareDeleteScenesRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene deletion plan payload is invalid" });
    const id = projectId(c);
    studioWriteInvocation(studio, c, id, `Delete ${parsed.data.sceneIds.length} scenes`);
    const prepared = valueOf(await prepareDeleteScenes(dependencies, {
      projectId: id,
      sceneIds: parsed.data.sceneIds,
      expectedRevision: parsed.data.expectedRevision,
    }));
    const grantId = await dependencies.approvals.request(
      prepared.binding,
      `Delete ${prepared.plan.sceneIds.length} scenes`,
    );
    return c.json(PrepareDeleteScenesResponseSchema.parse({ plan: prepared.plan, grantId }));
  });
  routes.post("/v1/projects/:id/scenes/deletions/:grantId", async (c) => {
    const parsed = DeleteScenesRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene deletion payload is invalid" });
    const grant = IdentifierSchema.safeParse(c.req.param("grantId"));
    if (!grant.success) fail({ code: ErrorCode.SchemaInvalid, message: "deletion grant id is invalid", field: "grantId" });
    const id = projectId(c);
    const invocation = studioWriteInvocation(studio, c, id, `Delete ${parsed.data.sceneIds.length} scenes`);
    const issuedGrantId = valueOf(await dependencies.approvals.issue(grant.data, "ui"));
    const deleted = valueOf(await deleteScenes(dependencies, {
      projectId: id,
      sceneIds: parsed.data.sceneIds,
      expectedRevision: parsed.data.expectedRevision,
      grantId: issuedGrantId,
    }, "user", invocation));
    return c.json(DeleteScenesResponseSchema.parse({
      project: deleted.project,
      revision: deleted.envelope.projectRevision,
      diagnostics: deleted.envelope.diagnostics,
      changeSeq: deleted.envelope.changeSeq,
      backupId: deleted.backupId,
      deletedFiles: deleted.deletedFiles,
      keptFiles: deleted.keptFiles,
    }));
  });
  routes.patch("/v1/projects/:id/scenes/:sceneId", async (c) => {
    const parsed = PatchSceneTimingRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene timing payload is invalid" });
    const id = projectId(c);
    const timed = valueOf(await setSceneTiming(dependencies, {
      projectId: id, sceneId: c.req.param("sceneId"), ...parsed.data,
    }, "user", studioWriteInvocation(studio, c, id, "Edit scene timing")));
    const file = valueOf(await readSourceFile(dependencies.reads, id, "index.html" as RelPath));
    return c.json({
      file,
      revision: timed.envelope.projectRevision,
      diagnostics: timed.envelope.diagnostics,
      changeSeq: timed.envelope.changeSeq,
    });
  });
  routes.put("/v1/projects/:id/scenes/:sceneId/elements/:elementId/position", async (c) => {
    const parsed = SetElementPositionRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "element position payload is invalid" });
    const sceneId = IdentifierSchema.safeParse(c.req.param("sceneId"));
    const elementId = AuthoredElementIdSchema.safeParse(c.req.param("elementId"));
    if (!sceneId.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene id is invalid", field: "sceneId" });
    if (!elementId.success) fail({ code: ErrorCode.SchemaInvalid, message: "element id is invalid", field: "elementId" });
    const id = projectId(c);
    const positioned = valueOf(await setElementPosition(dependencies, {
      projectId: id,
      sceneId: sceneId.data,
      elementId: elementId.data,
      ...parsed.data,
    }, "user", studioWriteInvocation(studio, c, id, "Move element")));
    return c.json(SetElementPositionResponseSchema.parse(positioned));
  });
  routes.patch("/v1/projects/:id/scenes/:sceneId/script", async (c) => {
    const parsed = PatchSceneScriptRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene script payload is invalid" });
    const id = projectId(c);
    const scripted = valueOf(await setSceneScript(dependencies, {
      projectId: id, sceneId: c.req.param("sceneId"), ...parsed.data, file: parsed.data.file as RelPath,
    }, "user", studioWriteInvocation(studio, c, id, "Edit scene script")));
    const file = valueOf(await readSourceFile(dependencies.reads, id, parsed.data.file as RelPath));
    return c.json({
      file,
      revision: scripted.envelope.projectRevision,
      diagnostics: scripted.envelope.diagnostics,
      changeSeq: scripted.envelope.changeSeq,
    });
  });
  routes.patch("/hf/:slug/scene", async (c) => {
    const parsed = LegacySceneMutationRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "legacy scene payload is invalid" });
    const id = valueOf(await resolveProjectIdBySlug(dependencies.reads, c.req.param("slug")));
    if (parsed.data.action === "tts") {
      const narration = valueOf(await regenerateNarration(dependencies, {
        projectId: id, sceneId: parsed.data.sceneId, text: parsed.data.text,
      }, "user", studioWriteInvocation(studio, c, id, "Regenerate narration")));
      const { changeSeq, ...record } = narration;
      return c.json({ ok: true, narration: record, changeSeq });
    }
    const prompt = parsed.data.prompt.trim();
    if (!prompt) fail({ code: ErrorCode.SchemaInvalid, message: "prompt is empty", field: "prompt" });
    const entry = valueOf(await readSourceFile(dependencies.reads, id, "index.html" as RelPath));
    const result = valueOf(await createScene(dependencies, {
      projectId: id,
      title: prompt,
      expectedContentHash: entry.contentHash,
    }, "agent", studioWriteInvocation(studio, c, id, "Create scene")));
    return c.json({
      ok: true,
      sceneId: result.scene.id,
      changeSeq: result.envelope.changeSeq,
      transcript: transcript(c.req.param("slug"), prompt, {
        sceneId: result.scene.id,
        start: result.scene.start,
        duration: result.scene.duration,
      }),
    });
  });
  return routes;
}
