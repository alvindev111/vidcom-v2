import {
  AssetParamsSchema,
  ErrorCode,
  ProjectParamsSchema,
  ReadProjectFileQuerySchema,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  getPreviewSettings,
  getProjectPreview,
  getStudioSnapshot,
  listProjects,
  readAsset,
  readSourceFile,
  resolveProjectIdBySlug,
  type EventOutboxPort,
  type ProjectReadDependencies,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

export interface ProjectReadRouteDependencies extends ProjectReadDependencies {
  events: Pick<EventOutboxPort, "latestProjectSeq">;
  runtimeSource(): string;
  mimeFromPath(path: string): string | null;
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

function assetPath(c: Context): RelPath {
  const parsed = AssetParamsSchema.safeParse({ id: c.req.param("id"), path: c.req.param("path") });
  return parsed.success
    ? parsed.data.path as RelPath
    : fail({ code: ErrorCode.SchemaInvalid, message: "asset path is invalid", field: "path" });
}

function requestedRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  const start = rawStart === "" ? size - Number(rawEnd) : Number(rawStart);
  const end = rawStart === "" || rawEnd === "" ? size - 1 : Number(rawEnd);
  const from = Math.max(start, 0);
  const to = Math.min(end, size - 1);
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { start: from, end: to } : null;
}

function foldableLines(content: string): number[] {
  const lines = content.split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;
  return lines.reduce<number[]>((result, line, index) => {
    const next = lines[index + 1];
    if (line.trim() && next?.trim() && indent(next) > indent(line)) result.push(index + 1);
    return result;
  }, []);
}

function assetResponse(c: Context, bytes: Uint8Array, contentHash: string, mime: string): Response {
  const etag = `"${contentHash}"`;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Type": mime,
    ETag: etag,
  };
  if (c.req.header("If-None-Match") === etag) return new Response(null, { status: 304, headers });
  const range = requestedRange(c.req.header("Range"), bytes.byteLength);
  if (!range) return new Response(Uint8Array.from(bytes).buffer, {
    headers: { ...headers, "Content-Length": String(bytes.byteLength) },
  });
  const body = bytes.slice(range.start, range.end + 1);
  return new Response(Uint8Array.from(body).buffer, {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(body.byteLength),
      "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
    },
  });
}

async function legacyId(dependencies: ProjectReadDependencies, slug: string): Promise<ProjectId> {
  const parsed = ProjectParamsSchema.safeParse({ id: slug });
  if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "project slug is invalid", field: "slug" });
  return valueOf(await resolveProjectIdBySlug(dependencies, slug));
}

export function createProjectReadRoutes(dependencies: ProjectReadRouteDependencies): Hono {
  const routes = new Hono();

  routes.get("/v1/runtime", (c) => c.body(dependencies.runtimeSource(), 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  }));
  routes.get("/hf/runtime", (c) => c.body(dependencies.runtimeSource(), 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  }));

  routes.get("/v1/projects", async (c) => c.json({ projects: valueOf(await listProjects(dependencies)) }));
  routes.get("/v1/projects/:id/studio-snapshot", async (c) =>
    c.json(valueOf(await getStudioSnapshot(dependencies, projectId(c)))));
  routes.get("/v1/projects/:id/files", async (c) => {
    const path = c.req.query("path");
    if (!path) fail({ code: ErrorCode.PathRequired, message: "path is required", field: "path" });
    const parsed = ReadProjectFileQuerySchema.safeParse({ path });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "file path is invalid", field: "path" });
    return c.json({ file: valueOf(await readSourceFile(dependencies, projectId(c), parsed.data.path as RelPath)) });
  });
  routes.get("/v1/projects/:id/preview-settings", async (c) =>
    c.json(valueOf(await getPreviewSettings(dependencies, projectId(c)))));
  routes.get("/hf/:slug/source", async (c) => {
    const path = c.req.query("path");
    if (!path) fail({ code: ErrorCode.PathRequired, message: "path is required", field: "path" });
    const parsed = ReadProjectFileQuerySchema.safeParse({ path });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "file path is invalid", field: "path" });
    const file = valueOf(await readSourceFile(
      dependencies,
      await legacyId(dependencies, c.req.param("slug")),
      parsed.data.path as RelPath,
    ));
    return c.json({
      file: {
        path: file.path,
        code: file.content,
        foldableLines: foldableLines(file.content),
        saved: true,
        version: file.contentHash,
      },
    });
  });
  routes.get("/hf/:slug/preview-settings", async (c) => {
    const settings = valueOf(await getPreviewSettings(
      dependencies,
      await legacyId(dependencies, c.req.param("slug")),
    ));
    return c.json({ settings: settings.previewSettings });
  });

  routes.get("/v1/projects/:id/preview", async (c) => {
    const id = projectId(c);
    const preview = valueOf(await getProjectPreview(dependencies, id, {
      runtimeUrl: "/api/v1/runtime",
      fileBaseUrl: `/api/v1/projects/${id}/assets/`,
    }));
    return c.html(preview.html, 200, { "Cache-Control": "no-store" });
  });
  routes.get("/hf/:slug/preview", async (c) => {
    const slug = c.req.param("slug");
    const id = await legacyId(dependencies, slug);
    const preview = valueOf(await getProjectPreview(dependencies, id, {
      runtimeUrl: "/api/hf/runtime",
      fileBaseUrl: `/api/hf/${slug}/files/`,
    }));
    return c.html(preview.html, 200, { "Cache-Control": "no-store" });
  });

  routes.get("/v1/projects/:id/assets/:path{.+}", async (c) => {
    const path = assetPath(c);
    const mime = dependencies.mimeFromPath(path);
    if (!mime) fail({ code: ErrorCode.AssetNotAllowed, message: "asset type is not served" });
    const asset = valueOf(await readAsset(dependencies, projectId(c), path));
    return assetResponse(c, asset.bytes, asset.contentHash, mime);
  });
  routes.get("/hf/:slug/files/:path{.+}", async (c) => {
    const slug = c.req.param("slug");
    const id = await legacyId(dependencies, slug);
    const path = c.req.param("path") as RelPath;
    const parsed = AssetParamsSchema.safeParse({ id, path });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "asset path is invalid", field: "path" });
    const mime = dependencies.mimeFromPath(path);
    if (!mime) fail({ code: ErrorCode.AssetNotAllowed, message: "asset type is not served" });
    const asset = valueOf(await readAsset(dependencies, id, path));
    return assetResponse(c, asset.bytes, asset.contentHash, mime);
  });

  return routes;
}
