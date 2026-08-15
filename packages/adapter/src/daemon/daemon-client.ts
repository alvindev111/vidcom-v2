import { ErrorCode } from "@vidcom/contracts";

export class DaemonClientError extends Error {
  readonly name = "DaemonClientError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly field?: string,
  ) {
    super(message);
  }
}

/** A request that never produced an HTTP response; safe read routes may retry it. */
class DaemonTransportError extends DaemonClientError {}

export type AttachmentKind = "bridge" | "ui" | "render";

export interface DaemonHandshake {
  workspaceRoot: string;
  instanceId: string;
  protocolVersions: readonly string[];
  daemonVersion: string;
}

export interface DaemonAttachment {
  attachmentId: string;
  heartbeatEveryMs: number;
  expiresAt: string;
}

export interface RemoteInvocationContext {
  protocolVersion: string;
  /**
   * The wire generation the bridge negotiated for this connection.
   *
   * Forwarded rather than derived on the daemon. The SDK decides it during
   * negotiation, and re-deriving it from the revision would be a second
   * negotiator that can disagree with the first — the same mistake as keeping
   * a second tool catalogue.
   */
  era: "legacy" | "modern";
  requestState?: unknown;
}

export interface EnqueuedRender {
  jobId: string;
}

export interface EnqueueRenderInput {
  idempotencyKey: string;
  renderPresetId?: string;
  bestEffort?: boolean;
}

export interface DaemonJob {
  id: string;
  status: string;
  progress?: number;
  stage?: string | null;
  error?: { code: string; message: string } | null;
}

/**
 * Everything a client is allowed to ask a daemon to do.
 *
 * Closed on purpose, and the absence of a generic `request(method, path, body)`
 * is the point (DR-6). The moment one exists the bridge is an HTTP proxy, every
 * allowlist becomes decoration, and a tool the daemon never published is one
 * hand-written path away.
 */
export interface DaemonClient {
  handshake(input: {
    workspaceRoot: string;
    expectedInstanceId: string;
    clientKind: AttachmentKind;
    clientVersion: string;
  }): Promise<DaemonHandshake>;
  attach(kind: AttachmentKind): Promise<DaemonAttachment>;
  renew(attachmentId: string): Promise<DaemonAttachment>;
  detach(attachmentId: string): Promise<void>;
  invokeTool(name: string, input: unknown, context: RemoteInvocationContext): Promise<unknown>;
  /** `render` is a thin client over these three; it builds no HTTP client of its own. */
  enqueueRender(projectId: string, input: EnqueueRenderInput): Promise<EnqueuedRender>;
  getJob(jobId: string): Promise<DaemonJob>;
  cancelJob(jobId: string): Promise<void>;
}

export interface DaemonClientOptions {
  baseUrl: string;
  bearer: string;
  /** Control-plane deadline; explicit value is the fallback for workload-specific calls too. */
  deadlineMs?: number;
  /** Tool execution may legitimately include validation/diagnostics work. */
  toolDeadlineMs?: number;
  /** Render enqueue performs diagnostics before the durable job row is returned. */
  renderEnqueueDeadlineMs?: number;
  /** Job reads are safe to retry once when no HTTP response was received. */
  jobReadDeadlineMs?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_DEADLINE_MS = 5_000;
const DEFAULT_TOOL_DEADLINE_MS = 120_000;
const DEFAULT_RENDER_ENQUEUE_DEADLINE_MS = 300_000;
const DEFAULT_JOB_READ_DEADLINE_MS = 120_000;
const BRIDGE_PREFIX = "/api/bridge/v1";

function unavailable(message: string, details?: Record<string, unknown>): DaemonClientError {
  return new DaemonClientError(ErrorCode.DaemonUnavailable, message, details);
}

function transportUnavailable(message: string, details?: Record<string, unknown>): DaemonTransportError {
  return new DaemonTransportError(ErrorCode.DaemonUnavailable, message, details);
}

/**
 * Maps a daemon response onto the error the caller can act on.
 *
 * The daemon's own stable code is preferred over anything derived from the
 * status, because the status alone cannot distinguish "this bearer is wrong"
 * from "this workspace belongs to another instance" — and those two need
 * opposite responses from the caller.
 */
async function decode(response: Response, what: string): Promise<unknown> {
  if (response.ok) {
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch (cause) {
      throw unavailable(`daemon returned an unreadable ${what} response`, {
        status: response.status,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  let detail: {
    code?: string;
    message?: string;
    field?: string;
    details?: Record<string, unknown>;
  } | undefined;
  let current: unknown;
  try {
    const body = await response.json() as { error?: typeof detail; current?: unknown };
    detail = body.error;
    current = body.current;
  } catch {
    detail = undefined;
  }
  if (detail?.code && detail.message) {
    const details = {
      ...detail.details,
      ...(current === undefined || detail.details?.current !== undefined ? {} : { current }),
    };
    throw new DaemonClientError(
      detail.code as ErrorCode,
      detail.message,
      Object.keys(details).length === 0 ? undefined : details,
      detail.field,
    );
  }
  throw new DaemonClientError(
    (detail?.code as ErrorCode | undefined) ?? ErrorCode.DaemonUnavailable,
    `daemon rejected ${what}`,
    { status: response.status },
  );
}

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
  const controlDeadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  // Preserve the old explicit-override behaviour for tests and callers that set
  // one global deadline, while making the production default fit real validate
  // and diagnostics work.
  const toolDeadlineMs = options.toolDeadlineMs ?? options.deadlineMs ?? DEFAULT_TOOL_DEADLINE_MS;
  const renderEnqueueDeadlineMs = options.renderEnqueueDeadlineMs
    ?? options.deadlineMs
    ?? DEFAULT_RENDER_ENQUEUE_DEADLINE_MS;
  const jobReadDeadlineMs = options.jobReadDeadlineMs
    ?? options.deadlineMs
    ?? DEFAULT_JOB_READ_DEADLINE_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  function call(
    what: string,
    method: string,
    route: string,
    body?: unknown,
    deadlineMs = controlDeadlineMs,
  ): Promise<unknown> {
    return callAt(`${options.baseUrl}${BRIDGE_PREFIX}${route}`, what, method, body, deadlineMs);
  }

  async function callAt(
    url: string,
    what: string,
    method: string,
    body: unknown,
    deadlineMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const response = await doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${options.bearer}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      return await decode(response, what);
    } catch (error) {
      if (error instanceof DaemonClientError) throw error;
      // Not retried at the generic boundary. Mutations may have been applied
      // before a timeout; the one retry-safe GET owns its bounded retry in
      // `getJob` where this transport-only subtype can be distinguished from a
      // structured HTTP rejection.
      throw transportUnavailable(`daemon did not answer ${what}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async handshake(input): Promise<DaemonHandshake> {
      const result = await call("handshake", "POST", "/handshake", input) as DaemonHandshake;
      // Checked here as well as on the daemon: the client is the side that knows
      // which instance it meant to reach, and a daemon that restarted between
      // discovery and handshake answers happily as itself.
      if (result.instanceId !== input.expectedInstanceId) {
        throw new DaemonClientError(
          ErrorCode.DaemonIdentityMismatch,
          "the daemon answering is not the one discovery pointed at",
          { expected: input.expectedInstanceId, actual: result.instanceId },
        );
      }
      if (result.workspaceRoot !== input.workspaceRoot) {
        throw new DaemonClientError(
          ErrorCode.DaemonIdentityMismatch,
          "the daemon owns a different workspace",
          { expected: input.workspaceRoot, actual: result.workspaceRoot },
        );
      }
      return result;
    },

    attach(kind): Promise<DaemonAttachment> {
      return call("attach", "POST", "/attachments", { kind }) as Promise<DaemonAttachment>;
    },

    renew(attachmentId): Promise<DaemonAttachment> {
      return call(
        "renew",
        "PUT",
        `/attachments/${encodeURIComponent(attachmentId)}`,
      ) as Promise<DaemonAttachment>;
    },

    async detach(attachmentId): Promise<void> {
      await call("detach", "DELETE", `/attachments/${encodeURIComponent(attachmentId)}`);
    },

    enqueueRender(projectId, input): Promise<EnqueuedRender> {
      return call(
        "render enqueue",
        "POST",
        `/projects/${encodeURIComponent(projectId)}/renders`,
        input,
        renderEnqueueDeadlineMs,
      ) as Promise<EnqueuedRender>;
    },

    async getJob(jobId): Promise<DaemonJob> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await call(
            "job read",
            "GET",
            `/jobs/${encodeURIComponent(jobId)}`,
            undefined,
            jobReadDeadlineMs,
          ) as DaemonJob;
        } catch (error) {
          // GET is the one retry-safe route on this client. A structured HTTP
          // rejection already reached the daemon and is authoritative; only a
          // fetch/abort that produced no response gets one bounded retry.
          if (!(error instanceof DaemonTransportError) || attempt === 1) throw error;
        }
      }
      throw new TypeError("job read retry did not run");
    },

    async cancelJob(jobId): Promise<void> {
      await call("job cancel", "POST", `/jobs/${encodeURIComponent(jobId)}/cancel`);
    },

    invokeTool(name, input, context): Promise<unknown> {
      // The name goes in the path so the daemon validates it against its own
      // allowlist. Encoding it keeps a name with a separator from addressing a
      // different route rather than being refused as an unknown tool.
      return call("tool invocation", "POST", `/tools/${encodeURIComponent(name)}`, {
        input,
        protocolVersion: context.protocolVersion,
        era: context.era,
        ...(context.requestState === undefined ? {} : { requestState: context.requestState }),
      }, toolDeadlineMs);
    },
  };
}
