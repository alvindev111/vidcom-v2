import {
  AssetParamsSchema,
  AssetMetadataSchema,
  ErrorCode,
  ProjectParamsSchema,
  PREVIEW_DOCUMENT_CSP,
  ReadProjectFileQuerySchema,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";
import {
  getPreviewSettings,
  getProjectPreview,
  getProjectAssetMetadata,
  getEntryExpectation,
  getStudioSnapshot,
  listProjects,
  openAssetRange,
  readSourceFile,
  resolveProjectIdBySlug,
  statAsset,
  type EventOutboxPort,
  type ProjectReadDependencies,
  type MediaProbePort,
  type EntryCrudDependencies,
} from "@vidcom/core";
import { Hono, type Context } from "hono";
import { HttpBoundaryError } from "../middleware/error-mapper";

export interface ProjectReadRouteDependencies extends ProjectReadDependencies {
  events: Pick<EventOutboxPort, "latestProjectSeq">;
  probe?: MediaProbePort;
  hashContent?(content: string | Uint8Array): import("@vidcom/contracts").ContentHash;
  runtimeSource(): string;
  motionLibrarySource?(): Promise<string>;
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

type ParsedRange =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "requested"; start: number | null; end: number | null };

type RequestedRange =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "satisfiable"; start: number; end: number };

function decimal(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Parses syntax before any asset I/O; size-dependent satisfiability is resolved after stat. */
function parseRange(header: string | undefined): ParsedRange {
  if (header === undefined) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return { kind: "invalid" };
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (rawStart === "" && rawEnd === "") return { kind: "invalid" };
  const start = rawStart === "" ? null : decimal(rawStart);
  const end = rawEnd === "" ? null : decimal(rawEnd);
  return (rawStart !== "" && start === null) || (rawEnd !== "" && end === null)
    ? { kind: "invalid" }
    : { kind: "requested", start, end };
}

function requestedRange(parsed: ParsedRange, size: number): RequestedRange {
  if (parsed.kind !== "requested") return parsed;
  if (size === 0) return { kind: "invalid" };
  if (parsed.start === null) {
    if (parsed.end === null || parsed.end === 0) return { kind: "invalid" };
    return {
      kind: "satisfiable",
      start: Math.max(size - parsed.end, 0),
      end: size - 1,
    };
  }
  if (parsed.start >= size) return { kind: "invalid" };
  const end = parsed.end ?? size - 1;
  if (end < parsed.start) return { kind: "invalid" };
  return { kind: "satisfiable", start: parsed.start, end: Math.min(end, size - 1) };
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

function ifNoneMatch(header: string | undefined, etag: string): boolean {
  return header?.split(",").some((candidate) => candidate.trim() === "*" || candidate.trim() === etag) ?? false;
}

function ifRangeAllows(header: string | undefined, etag: string): boolean {
  if (header === undefined) return true;
  return !header.startsWith("W/") && !etag.startsWith("W/") && header === etag;
}

async function assetResponse(
  c: Context,
  dependencies: ProjectReadDependencies,
  id: ProjectId,
  path: RelPath,
  mime: string,
): Promise<Response> {
  const parsedRange = parseRange(c.req.header("Range"));
  const metadata = valueOf(await statAsset(dependencies, id, path));
  const range = requestedRange(parsedRange, metadata.size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Type": mime,
    ETag: metadata.etag,
  };
  if (range.kind === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Length": "0", "Content-Range": `bytes */${metadata.size}` },
    });
  }
  if (ifNoneMatch(c.req.header("If-None-Match"), metadata.etag)) {
    return new Response(null, { status: 304, headers });
  }
  const partial = range.kind === "satisfiable"
    && ifRangeAllows(c.req.header("If-Range"), metadata.etag);
  const start = partial ? range.start : 0;
  const end = partial ? range.end : metadata.size - 1;
  const responseHeaders: Record<string, string> = {
    ...headers,
    "Content-Length": String(end - start + 1),
  };
  if (partial) responseHeaders["Content-Range"] = `bytes ${start}-${end}/${metadata.size}`;
  if (metadata.size === 0) return new Response(null, { status: 200, headers: responseHeaders });
  const opened = valueOf(await openAssetRange(dependencies, id, path, {
    start,
    end,
    identity: metadata.identity,
    signal: c.req.raw.signal,
  }));
  return new Response(opened.stream, { status: partial ? 206 : 200, headers: responseHeaders });
}

function previewHeaders(preview: { projectRevision: number; changeSeq: number }) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": PREVIEW_DOCUMENT_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Vidcom-Project-Revision": String(preview.projectRevision),
    "X-Vidcom-Change-Seq": String(preview.changeSeq),
  };
}

async function legacyId(dependencies: ProjectReadDependencies, slug: string): Promise<ProjectId> {
  const parsed = ProjectParamsSchema.safeParse({ id: slug });
  if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "project slug is invalid", field: "slug" });
  return valueOf(await resolveProjectIdBySlug(dependencies, slug));
}

export function createProjectReadRoutes(dependencies: ProjectReadRouteDependencies): Hono {
  const routes = new Hono();

  routes.get("/preview/v1/c/:cap/projects/:id/runtime", (c) => c.body(dependencies.runtimeSource(), 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  }));
  routes.get("/preview/v1/c/:cap/projects/:id/vendor/gsap.js", async (c) => {
    if (!dependencies.motionLibrarySource) {
      fail({ code: ErrorCode.StorageUnavailable, message: "preview motion runtime is unavailable" });
    }
    return c.body(await dependencies.motionLibrarySource(), 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, immutable",
    });
  });
  routes.get("/preview/v1/c/:cap/projects/:id/preview", async (c) => {
    const id = projectId(c);
    const capabilityPath = `/api/preview/v1/c/${encodeURIComponent(c.req.param("cap"))}/projects/${id}`;
    const preview = valueOf(await getProjectPreview(dependencies, id, {
      runtimeUrl: `${capabilityPath}/runtime`,
      fileBaseUrl: `${capabilityPath}/assets/`,
    }));
    return c.html(preview.html, 200, previewHeaders(preview));
  });
  routes.get("/preview/v1/c/:cap/projects/:id/assets/:path{.+}", async (c) => {
    const path = assetPath(c);
    const mime = dependencies.mimeFromPath(path);
    if (!mime) fail({ code: ErrorCode.AssetNotAllowed, message: "asset type is not served" });
    return assetResponse(c, dependencies, projectId(c), path, mime);
  });

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
    const id = projectId(c);
    const source = await readSourceFile(dependencies, id, parsed.data.path as RelPath);
    if (source.ok) {
      return c.json({
        file: source.value,
        entry: { path: source.value.path, kind: "file", expectedContentHash: source.value.contentHash },
      });
    }
    if (!dependencies.hashContent) fail(source.error);
    return c.json({ entry: valueOf(await getEntryExpectation({
      workspace: dependencies.workspace as EntryCrudDependencies["workspace"],
      hashContent: dependencies.hashContent,
    }, { projectId: id, path: parsed.data.path as RelPath })) });
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
    return c.html(preview.html, 200, previewHeaders(preview));
  });
  routes.get("/hf/:slug/preview", async (c) => {
    const slug = c.req.param("slug");
    const id = await legacyId(dependencies, slug);
    const preview = valueOf(await getProjectPreview(dependencies, id, {
      runtimeUrl: "/api/hf/runtime",
      fileBaseUrl: `/api/hf/${slug}/files/`,
    }));
    return c.html(preview.html, 200, previewHeaders(preview));
  });

  routes.get("/v1/projects/:id/assets/:path{.+}/metadata", async (c) => {
    const id = projectId(c);
    if (!dependencies.probe) fail({ code: ErrorCode.StorageUnavailable, message: "asset metadata probe is unavailable" });
    return c.json(AssetMetadataSchema.parse(valueOf(await getProjectAssetMetadata(
      { workspace: dependencies.workspace, probe: dependencies.probe },
      { projectId: id, path: assetPath(c) },
    ))));
  });
  routes.get("/v1/projects/:id/assets/:path{.+}", async (c) => {
    const path = assetPath(c);
    const mime = dependencies.mimeFromPath(path);
    if (!mime) fail({ code: ErrorCode.AssetNotAllowed, message: "asset type is not served" });
    return assetResponse(c, dependencies, projectId(c), path, mime);
  });
  routes.get("/hf/:slug/files/:path{.+}", async (c) => {
    const slug = c.req.param("slug");
    const id = await legacyId(dependencies, slug);
    const path = c.req.param("path") as RelPath;
    const parsed = AssetParamsSchema.safeParse({ id, path });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "asset path is invalid", field: "path" });
    const mime = dependencies.mimeFromPath(path);
    if (!mime) fail({ code: ErrorCode.AssetNotAllowed, message: "asset type is not served" });
    return assetResponse(c, dependencies, id, path, mime);
  });

  return routes;
}
