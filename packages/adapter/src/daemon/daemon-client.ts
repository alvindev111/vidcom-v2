import { ErrorCode } from "@vidcom/contracts";

export class DaemonClientError extends Error {
  readonly name = "DaemonClientError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

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
  requestState?: unknown;
}

export interface EnqueuedRender {
  jobId: string;
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
  enqueueRender(projectId: string, input: Record<string, unknown>): Promise<EnqueuedRender>;
  getJob(jobId: string): Promise<DaemonJob>;
  cancelJob(jobId: string): Promise<void>;
}

export interface DaemonClientOptions {
  baseUrl: string;
  bearer: string;
  /** Every call gets one. A daemon that accepts a socket and then stalls is the failure this bounds. */
  deadlineMs?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_DEADLINE_MS = 5_000;
const BRIDGE_PREFIX = "/api/bridge/v1";

function unavailable(message: string, details?: Record<string, unknown>): DaemonClientError {
  return new DaemonClientError(ErrorCode.DaemonUnavailable, message, details);
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

  let code: string | undefined;
  try {
    const body = await response.json() as { error?: { code?: string } };
    code = body.error?.code;
  } catch {
    code = undefined;
  }
  throw new DaemonClientError(
    (code as ErrorCode | undefined) ?? ErrorCode.DaemonUnavailable,
    `daemon rejected ${what}`,
    { status: response.status },
  );
}

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const doFetch = options.fetch ?? globalThis.fetch;

  function call(what: string, method: string, route: string, body?: unknown): Promise<unknown> {
    return callAt(`${options.baseUrl}${BRIDGE_PREFIX}${route}`, what, method, body);
  }

  async function callAt(url: string, what: string, method: string, body?: unknown): Promise<unknown> {
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
      // Not retried, deliberately. Every route here except the handshake
      // mutates daemon state, and a request that timed out may well have been
      // applied — a blind retry turns one attachment into two, or one tool call
      // into two side effects.
      throw unavailable(`daemon did not answer ${what}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // The product API, not the bridge prefix. Still named routes: the point of
  // the closed surface is that no caller can compose a path of its own, not
  // that every route happens to live under one prefix.
  function callApi(what: string, method: string, route: string, body?: unknown): Promise<unknown> {
    return callAt(`${options.baseUrl}/api${route}`, what, method, body);
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
      return callApi(
        "render enqueue",
        "POST",
        `/v1/projects/${encodeURIComponent(projectId)}/renders`,
        input,
      ) as Promise<EnqueuedRender>;
    },

    getJob(jobId): Promise<DaemonJob> {
      return callApi("job read", "GET", `/v1/jobs/${encodeURIComponent(jobId)}`) as Promise<DaemonJob>;
    },

    async cancelJob(jobId): Promise<void> {
      await callApi("job cancel", "POST", `/v1/jobs/${encodeURIComponent(jobId)}/cancel`);
    },

    invokeTool(name, input, context): Promise<unknown> {
      // The name goes in the path so the daemon validates it against its own
      // allowlist. Encoding it keeps a name with a separator from addressing a
      // different route rather than being refused as an unknown tool.
      return call("tool invocation", "POST", `/tools/${encodeURIComponent(name)}`, {
        input,
        protocolVersion: context.protocolVersion,
        ...(context.requestState === undefined ? {} : { requestState: context.requestState }),
      });
    },
  };
}
