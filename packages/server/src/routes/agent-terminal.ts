import {
  AgentTerminalInputRequestSchema,
  AgentTerminalResizeRequestSchema,
  ErrorCode,
  ProjectParamsSchema,
  StartAgentTerminalRequestSchema,
  type AgentTerminalFrame,
  type ProjectId,
  type StartAgentTerminalResponse,
} from "@vidcom/contracts";
import {
  startAgentTerminal,
  type AgentTerminalSession,
  type StartAgentTerminalDependencies,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

/** Everything the terminal routes need; the use case owns the policy behind it. */
export type AgentTerminalRouteDependencies = StartAgentTerminalDependencies;

/** 15 s — under any proxy or browser idle cutoff, and invisible on a live terminal. */
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_QUEUE_EVENTS = 256;
const MAX_STREAM_QUEUE_BYTES = 512 * 1024;

function fail(error: { code: ErrorCode; message: string; field?: string }): never {
  throw new HttpBoundaryError(error);
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

/**
 * The session named in the path, checked against the project in the path.
 *
 * Both halves matter: a session id alone would let a request reach a terminal
 * belonging to a project the URL does not mention, which is the kind of gap that
 * only shows up once two projects are open side by side.
 */
function session(
  dependencies: AgentTerminalRouteDependencies,
  c: Context,
): AgentTerminalSession {
  const found = dependencies.terminals.find(c.req.param("sessionId") ?? "");
  if (!found || found.projectId !== projectId(c)) {
    fail({ code: ErrorCode.NotFound, message: "agent terminal session is not open" });
  }
  return found;
}

/**
 * The agent terminal of one project: start, read, type, resize, stop.
 *
 * Output is a Server-Sent Events stream rather than a WebSocket. An upgrade
 * leaves the Hono middleware chain entirely, and that chain is where the Host
 * check, the strict CORS policy and the session cookie are enforced — a
 * terminal that spawns processes is the last endpoint that should be reached
 * around them ([09-security](../../../../llm-documents/steering/09-security.md) §2–§4).
 */
export function createAgentTerminalRoutes(
  dependencies: AgentTerminalRouteDependencies,
): Hono {
  const routes = new Hono();

  routes.post("/v1/projects/:id/agent-terminal", async (c) => {
    const parsed = StartAgentTerminalRequestSchema.safeParse(await json(c));
    if (!parsed.success) {
      fail({ code: ErrorCode.SchemaInvalid, message: "agent terminal request is invalid" });
    }
    const started = await startAgentTerminal(dependencies, {
      projectId: projectId(c),
      agent: parsed.data.agent,
      cols: parsed.data.cols,
      rows: parsed.data.rows,
    });
    if (!started.ok) throw new HttpBoundaryError(started.error);
    const body: StartAgentTerminalResponse = {
      sessionId: started.value.session.id,
      agent: started.value.session.agent,
      mcpServerName: dependencies.mcpServer.name,
      reattached: started.value.reattached,
    };
    return c.json(body, started.value.reattached ? 200 : 201);
  });

  routes.get("/v1/projects/:id/agent-terminal/:sessionId/stream", (c) => {
    const live = session(dependencies, c);
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let sourceDetached = false;
    let stopped = false;
    let sourceEnded = false;
    let queuedBytes = 0;
    let lastWrite = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resumeWait: (() => void) | undefined;
    let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const queue: Array<{ bytes: Uint8Array; closeAfter: boolean }> = [];
    const wake = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const resume = resumeWait;
      resumeWait = undefined;
      resume?.();
    };
    const detachSource = () => {
      if (sourceDetached) return;
      sourceDetached = true;
      unsubscribe();
    };
    const cleanup = () => {
      detachSource();
      wake();
      c.req.raw.signal.removeEventListener("abort", abortStream);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
      queuedBytes = 0;
      cleanup();
    };
    const abortStream = () => {
      stop();
      try { activeController?.close(); } catch { /* request already closed */ }
    };
    const encodedFrame = (frame: AgentTerminalFrame): Uint8Array => encoder.encode(
      `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
    );
    const overflowFrame = () => encoder.encode(
      `event: error\ndata: ${JSON.stringify({
        type: "error",
        code: ErrorCode.ResourceLimitExceeded,
        message: "terminal output exceeded the suspended-consumer queue",
      })}\n\n`,
    );
    const push = (frame: AgentTerminalFrame) => {
      if (stopped || sourceEnded) return;
      const bytes = encodedFrame(frame);
      if (queue.length + 1 > MAX_STREAM_QUEUE_EVENTS || queuedBytes + bytes.byteLength > MAX_STREAM_QUEUE_BYTES) {
        queue.length = 0;
        queuedBytes = 0;
        const overflow = overflowFrame();
        queue.push({ bytes: overflow, closeAfter: true });
        queuedBytes = overflow.byteLength;
        sourceEnded = true;
        detachSource();
        wake();
        return;
      }
      const closeAfter = frame.type === "exit";
      queue.push({ bytes, closeAfter });
      queuedBytes += bytes.byteLength;
      if (closeAfter) {
        sourceEnded = true;
        detachSource();
      }
      wake();
    };
    c.req.raw.signal.addEventListener("abort", abortStream, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        activeController = controller;
        const subscribed = live.subscribe(push);
        unsubscribe = subscribed;
        if (sourceDetached) subscribed();
      },
      async pull(controller) {
        activeController = controller;
        while (!stopped && (controller.desiredSize ?? 0) > 0) {
          const next = queue.shift();
          if (next) {
            queuedBytes -= next.bytes.byteLength;
            controller.enqueue(next.bytes);
            lastWrite = Date.now();
            if (next.closeAfter) {
              stopped = true;
              cleanup();
              controller.close();
              return;
            }
            continue;
          }
          if (sourceEnded) {
            stopped = true;
            cleanup();
            controller.close();
            return;
          }
          const heartbeatIn = HEARTBEAT_MS - (Date.now() - lastWrite);
          if (heartbeatIn <= 0) {
            controller.enqueue(encoder.encode(":hb\n\n"));
            lastWrite = Date.now();
            continue;
          }
          await new Promise<void>((resolve) => {
            resumeWait = resolve;
            timer = setTimeout(wake, heartbeatIn);
            timer.unref?.();
          });
        }
      },
      cancel() {
        stop();
      },
    });
    if (c.req.raw.signal.aborted) abortStream();
    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  });

  routes.post("/v1/projects/:id/agent-terminal/:sessionId/input", async (c) => {
    const live = session(dependencies, c);
    const parsed = AgentTerminalInputRequestSchema.safeParse(await json(c));
    if (!parsed.success) {
      fail({ code: ErrorCode.SchemaInvalid, message: "terminal input is invalid", field: "data" });
    }
    live.write(parsed.data.data);
    return c.body(null, 204);
  });

  routes.post("/v1/projects/:id/agent-terminal/:sessionId/resize", async (c) => {
    const live = session(dependencies, c);
    const parsed = AgentTerminalResizeRequestSchema.safeParse(await json(c));
    if (!parsed.success) {
      fail({ code: ErrorCode.SchemaInvalid, message: "terminal size is invalid" });
    }
    live.resize(parsed.data.cols, parsed.data.rows);
    return c.body(null, 204);
  });

  routes.delete("/v1/projects/:id/agent-terminal/:sessionId", (c) => {
    session(dependencies, c).close();
    return c.body(null, 204);
  });

  return routes;
}
