import { ErrorCode, EventsHeadersSchema } from "@vidcom/contracts";
import type { EventOutboxPort, StoredEvent } from "@vidcom/core";
import { Hono } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

function frame(event: StoredEvent): string {
  const data = { id: event.seq, type: event.type, projectId: event.projectId, payload: event.payload };
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Durable SSE feed that resumes from SQLite rather than process memory. */
export function createEventRoutes(
  outbox: EventOutboxPort,
  options: { pollMs?: number; heartbeatMs?: number } = {},
): Hono {
  const routes = new Hono();
  routes.get("/events", (c) => {
    const parsed = EventsHeadersSchema.safeParse({ lastEventId: c.req.header("Last-Event-ID") });
    if (!parsed.success) {
      throw new HttpBoundaryError({
        code: ErrorCode.SchemaInvalid, message: "Last-Event-ID is invalid", field: "Last-Event-ID",
      });
    }
    const encoder = new TextEncoder();
    const pollMs = options.pollMs ?? 250;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    let cursor = parsed.data.lastEventId ?? 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastWrite = Date.now();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const pump = async () => {
          if (stopped) return;
          try {
            const batch = await outbox.readFrom(cursor, 100);
            if (batch.gap) {
              const latestSeq = await outbox.latestSeq();
              controller.enqueue(encoder.encode(
                `id: ${latestSeq}\nevent: resync\ndata: ${JSON.stringify({ id: latestSeq, type: "resync", reason: "outside_retention", latestSeq })}\n\n`,
              ));
              cursor = latestSeq;
              lastWrite = Date.now();
            } else {
              for (const event of batch.events) {
                controller.enqueue(encoder.encode(frame(event)));
                cursor = event.seq;
                lastWrite = Date.now();
              }
            }
            if (Date.now() - lastWrite >= heartbeatMs) {
              controller.enqueue(encoder.encode(":hb\n\n"));
              lastWrite = Date.now();
            }
            timer = setTimeout(() => void pump(), pollMs);
          } catch (error) {
            controller.error(error);
          }
        };
        await pump();
      },
      cancel() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    });
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
