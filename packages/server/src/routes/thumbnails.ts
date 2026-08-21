import {
  ErrorCode,
  ProjectParamsSchema,
  ThumbnailImageParamsSchema,
  TimelineThumbnailLineSchema,
  TimelineThumbnailRequestSchema,
  type DomainError,
  type ProjectId,
  type TimelineThumbnailLine,
} from "@vidcom/contracts";
import type {
  ThumbnailBatchScheduler,
  ThumbnailCachePort,
  ThumbnailService,
  WorkspacePort,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

export interface ThumbnailRouteDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef">;
  service: Pick<ThumbnailService, "plan" | "renderKey">;
  scheduler: Pick<ThumbnailBatchScheduler, "requestPlanned">;
  cache: Pick<ThumbnailCachePort, "get">;
}

function fail(error: DomainError): never {
  throw new HttpBoundaryError(error);
}

function projectId(c: Context): ProjectId {
  const parsed = ProjectParamsSchema.safeParse({ id: c.req.param("id") });
  return parsed.success
    ? parsed.data.id as ProjectId
    : fail({ code: ErrorCode.SchemaInvalid, message: "project id is invalid", field: "id" });
}

function ndjson(lines: readonly TimelineThumbnailLine[]): Response {
  return new Response(lines.map((line) => `${JSON.stringify(TimelineThumbnailLineSchema.parse(line))}\n`).join(""), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}

function placeholderLines(atSeconds: readonly number[], reason: ErrorCode): TimelineThumbnailLine[] {
  return atSeconds.map((at) => ({ atSeconds: at, status: "placeholder", reason }));
}

function errorCode(error: unknown): ErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && Object.values(ErrorCode).includes(code as ErrorCode)
    ? code as ErrorCode
    : ErrorCode.Internal;
}

export function createThumbnailRoutes(dependencies: ThumbnailRouteDependencies): Hono {
  const routes = new Hono();

  routes.post("/v1/projects/:id/thumbnails", async (c) => {
    const parsed = TimelineThumbnailRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "thumbnail request is invalid" });
    const id = projectId(c);
    const ref = await dependencies.workspace.readProjectRef(id);
    if (!ref) fail({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
    const planned = await dependencies.service.plan(ref, parsed.data);
    if (!planned.ok) {
      return planned.error.code === ErrorCode.DependencyGraphUnavailable
        ? ndjson(placeholderLines(parsed.data.atSeconds, planned.error.code))
        : fail(planned.error);
    }

    const requestSignal = c.req.raw.signal;
    const batchAbort = new AbortController();
    const abortBatch = () => batchAbort.abort(requestSignal.reason);
    if (requestSignal.aborted) abortBatch();
    else requestSignal.addEventListener("abort", abortBatch, { once: true });
    const signal = batchAbort.signal;
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void dependencies.scheduler.requestPlanned(ref, parsed.data, planned.value, signal).then((results) => {
          if (cancelled) return;
          for (const item of results) {
            const line: TimelineThumbnailLine = item.result.ok
              ? {
                  atSeconds: item.key.atSeconds,
                  status: "ready",
                  url: `/api/v1/projects/${encodeURIComponent(id)}/thumbnails/${dependencies.service.renderKey(item.key)}`,
                }
              : { atSeconds: item.key.atSeconds, status: "placeholder", reason: item.result.error.code };
            controller.enqueue(encoder.encode(`${JSON.stringify(TimelineThumbnailLineSchema.parse(line))}\n`));
          }
          controller.close();
        }).catch((error: unknown) => {
          if (cancelled) return;
          if (!signal.aborted) {
            for (const line of placeholderLines(parsed.data.atSeconds, errorCode(error))) {
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            }
          }
          controller.close();
        }).finally(() => requestSignal.removeEventListener("abort", abortBatch));
      },
      cancel() {
        cancelled = true;
        batchAbort.abort(new DOMException("thumbnail response was cancelled", "AbortError"));
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/x-ndjson; charset=utf-8",
      },
    });
  });

  routes.get("/v1/projects/:id/thumbnails/:key", async (c) => {
    const parsed = ThumbnailImageParamsSchema.safeParse({ id: c.req.param("id"), key: c.req.param("key") });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "thumbnail key is invalid", field: "key" });
    const bytes = await dependencies.cache.get(parsed.data.id as ProjectId, parsed.data.key);
    if (!bytes) fail({ code: ErrorCode.NotFound, message: "thumbnail was not found" });
    return new Response(Uint8Array.from(bytes).buffer, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "image/webp",
      },
    });
  });

  return routes;
}
