import {
  ErrorCode,
  MAX_BGM_BYTES,
  MAX_SOURCE_BYTES,
  LegacySceneMutationRequestSchema,
  PatchPreviewSettingsRequestSchema,
  PatchSceneScriptRequestSchema,
  PatchSceneTimingRequestSchema,
  ProjectParamsSchema,
  PutProjectFileRequestSchema,
  UploadBgmRequestSchema,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  createScene,
  patchPreviewSettings,
  regenerateNarration,
  readSourceFile,
  resolveProjectIdBySlug,
  saveSourceFile,
  setSceneScript,
  setSceneTiming,
  uploadBgm,
  type ProjectReadDependencies,
  type ProjectWriteDependencies,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

export interface ProjectWriteRouteDependencies extends ProjectWriteDependencies {
  reads: ProjectReadDependencies;
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
export function createProjectWriteRoutes(dependencies: ProjectWriteRouteDependencies): Hono {
  const routes = new Hono();
  routes.put("/v1/projects/:id/files", async (c) => {
    const parsed = PutProjectFileRequestSchema.safeParse(await json(c));
    if (!parsed.success) {
      const oversized = parsed.error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "content");
      fail({
        code: oversized ? ErrorCode.TooLarge : ErrorCode.SchemaInvalid,
        message: oversized ? `source content exceeds ${MAX_SOURCE_BYTES} bytes` : "file write payload is invalid",
      });
    }
    const saved = valueOf(await saveSourceFile(dependencies, {
      projectId: projectId(c),
      path: parsed.data.path as RelPath,
      content: parsed.data.content,
      expectedContentHash: parsed.data.expectedContentHash,
    }, "user"));
    return c.json({
      file: { ...saved.file, content: parsed.data.content },
      revision: saved.envelope.projectRevision,
      diagnostics: saved.envelope.diagnostics,
    });
  });
  routes.patch("/v1/projects/:id/preview-settings", async (c) => {
    const parsed = PatchPreviewSettingsRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "preview settings payload is invalid" });
    return c.json(valueOf(await patchPreviewSettings(dependencies, {
      projectId: projectId(c), ...parsed.data,
    }, "user")));
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
    return c.json(valueOf(await uploadBgm(dependencies, {
      projectId: projectId(c), name: parsed.data.file.name, bytes,
      expectedRevision: parsed.data.expectedRevision,
    }, "user")));
  });
  routes.patch("/v1/projects/:id/scenes/:sceneId", async (c) => {
    const parsed = PatchSceneTimingRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene timing payload is invalid" });
    const id = projectId(c);
    const timed = valueOf(await setSceneTiming(dependencies, {
      projectId: id, sceneId: c.req.param("sceneId"), ...parsed.data,
    }, "user"));
    const file = valueOf(await readSourceFile(dependencies.reads, id, "index.html" as RelPath));
    return c.json({ file, revision: timed.envelope.projectRevision, diagnostics: timed.envelope.diagnostics });
  });
  routes.patch("/v1/projects/:id/scenes/:sceneId/script", async (c) => {
    const parsed = PatchSceneScriptRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "scene script payload is invalid" });
    const id = projectId(c);
    const scripted = valueOf(await setSceneScript(dependencies, {
      projectId: id, sceneId: c.req.param("sceneId"), ...parsed.data, file: parsed.data.file as RelPath,
    }, "user"));
    const file = valueOf(await readSourceFile(dependencies.reads, id, parsed.data.file as RelPath));
    return c.json({ file, revision: scripted.envelope.projectRevision, diagnostics: scripted.envelope.diagnostics });
  });
  routes.patch("/hf/:slug/scene", async (c) => {
    const parsed = LegacySceneMutationRequestSchema.safeParse(await json(c));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "legacy scene payload is invalid" });
    const id = valueOf(await resolveProjectIdBySlug(dependencies.reads, c.req.param("slug")));
    if (parsed.data.action === "tts") {
      return c.json({ ok: true, narration: valueOf(await regenerateNarration(dependencies, {
        projectId: id, sceneId: parsed.data.sceneId, text: parsed.data.text,
      }, "user")) });
    }
    const prompt = parsed.data.prompt.trim();
    if (!prompt) fail({ code: ErrorCode.SchemaInvalid, message: "prompt is empty", field: "prompt" });
    const entry = valueOf(await readSourceFile(dependencies.reads, id, "index.html" as RelPath));
    const result = valueOf(await createScene(dependencies, {
      projectId: id,
      title: prompt,
      expectedContentHash: entry.contentHash,
    }, "agent"));
    return c.json({
      ok: true,
      sceneId: result.scene.id,
      transcript: transcript(c.req.param("slug"), prompt, {
        sceneId: result.scene.id,
        start: result.scene.start,
        duration: result.scene.duration,
      }),
    });
  });
  return routes;
}
