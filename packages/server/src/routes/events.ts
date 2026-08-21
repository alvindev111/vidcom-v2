import { ErrorCode, EventsHeadersSchema, ProjectParamsSchema, type ProjectId } from "@vidcom/contracts";
import type { EventOutboxPort, StoredEvent } from "@vidcom/core";
import { Hono } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";
import { requireAttachedStudio, STUDIO_SESSION_HEADER, type StudioRouteDependencies } from "./studio-session";

const MAX_EVENT_QUEUE_EVENTS = 100;
const MAX_EVENT_QUEUE_BYTES = 1024 * 1024;

function frame(event: StoredEvent): string {
  const data = { id: event.seq, type: event.type, projectId: event.projectId, payload: event.payload };
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Durable SSE feed that resumes from SQLite rather than process memory. */
export function createEventRoutes(
  outbox: EventOutboxPort,
  options: { pollMs?: number; heartbeatMs?: number } = {},
  studio?: StudioRouteDependencies,
): Hono {
  const routes = new Hono();
  routes.get("/events", (c) => {
    const parsed = EventsHeadersSchema.safeParse({ lastEventId: c.req.header("Last-Event-ID") });
    if (!parsed.success) {
      throw new HttpBoundaryError({
        code: ErrorCode.SchemaInvalid, message: "Last-Event-ID is invalid", field: "Last-Event-ID",
      });
    }
    const requestedStudio = c.req.header(STUDIO_SESSION_HEADER);
    const requestedProject = c.req.query("projectId");
    if ((requestedStudio === undefined) !== (requestedProject === undefined)) {
      throw new HttpBoundaryError({
        code: ErrorCode.PreconditionRequired,
        message: "studio session and projectId are required together",
      });
    }
    let leased: {
      browserSessionId: string;
      studioSessionId: string;
      projectId: ProjectId;
      generation: number;
    } | undefined;
    if (requestedStudio !== undefined) {
      if (!studio) throw new HttpBoundaryError({ code: ErrorCode.SchemaInvalid, message: "studio history is unavailable" });
      const project = ProjectParamsSchema.safeParse({ id: requestedProject });
      if (!project.success) throw new HttpBoundaryError({ code: ErrorCode.SchemaInvalid, message: "project id is invalid" });
      const id = project.data.id as ProjectId;
      const attached = requireAttachedStudio(studio, c, id);
      const generation = studio.history.openEventLease(attached.browserSessionId, attached.studioSessionId, id);
      if (generation === null) {
        throw new HttpBoundaryError({ code: ErrorCode.SchemaInvalid, message: "studio event lease could not be opened" });
      }
      leased = { ...attached, projectId: id, generation };
    }
    const encoder = new TextEncoder();
    const pollMs = options.pollMs ?? 250;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    let cursor = parsed.data.lastEventId ?? 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resumeWait: (() => void) | undefined;
    let lastWrite = Date.now();
    let leaseClosed = false;
    let closing = false;
    let queuedBytes = 0;
    const pending: Array<{ bytes: Uint8Array; cursor: number | null; closeAfter: boolean }> = [];
    const closeLease = () => {
      if (leaseClosed || !leased || !studio) return;
      leaseClosed = true;
      studio.history.closeEventLease(
        leased.browserSessionId,
        leased.studioSessionId,
        leased.projectId,
        leased.generation,
      );
    };
    const wake = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const resume = resumeWait;
      resumeWait = undefined;
      resume?.();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      pending.length = 0;
      wake();
      closeLease();
      c.req.raw.signal.removeEventListener("abort", stop);
    };
    const queueFrame = (bytes: Uint8Array, nextCursor: number | null) => {
      if (closing) return;
      if (pending.length + 1 > MAX_EVENT_QUEUE_EVENTS || queuedBytes + bytes.byteLength > MAX_EVENT_QUEUE_BYTES) {
        pending.length = 0;
        queuedBytes = 0;
        const overflow = encoder.encode(
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            code: ErrorCode.ResourceLimitExceeded,
            message: "event output exceeded the suspended-consumer queue",
          })}\n\n`,
        );
        pending.push({ bytes: overflow, cursor: null, closeAfter: true });
        queuedBytes = overflow.byteLength;
        closing = true;
        return;
      }
      pending.push({ bytes, cursor: nextCursor, closeAfter: false });
      queuedBytes += bytes.byteLength;
    };
    c.req.raw.signal.addEventListener("abort", stop, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          while (!stopped && (controller.desiredSize ?? 0) > 0) {
            const next = pending.shift();
            if (next) {
              queuedBytes -= next.bytes.byteLength;
              controller.enqueue(next.bytes);
              if (next.cursor !== null) cursor = next.cursor;
              lastWrite = Date.now();
              if (next.closeAfter) {
                stopped = true;
                pending.length = 0;
                queuedBytes = 0;
                wake();
                closeLease();
                c.req.raw.signal.removeEventListener("abort", stop);
                controller.close();
                return;
              }
              continue;
            }

            const batch = await outbox.readFrom(cursor, MAX_EVENT_QUEUE_EVENTS);
            if (stopped) return;
            if (batch.gap) {
              const latestSeq = await outbox.latestSeq();
              if (stopped) return;
              queueFrame(
                encoder.encode(
                  `id: ${latestSeq}\nevent: resync\ndata: ${JSON.stringify({ id: latestSeq, type: "resync", reason: "outside_retention", latestSeq })}\n\n`,
                ),
                latestSeq,
              );
            } else {
              for (const event of batch.events) {
                queueFrame(encoder.encode(frame(event)), event.seq);
              }
            }
            if (pending.length > 0) continue;

            const heartbeatIn = heartbeatMs - (Date.now() - lastWrite);
            if (heartbeatIn <= 0) {
              queueFrame(encoder.encode(":hb\n\n"), null);
              continue;
            }

            await new Promise<void>((resolve) => {
              resumeWait = resolve;
              timer = setTimeout(wake, Math.max(1, Math.min(pollMs, heartbeatIn)));
              timer.unref?.();
            });
          }
        } catch (error) {
          stop();
          controller.error(error);
        }
      },
      cancel() {
        stop();
      },
    });
    if (c.req.raw.signal.aborted) stop();
    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  });
  return routes;
}
