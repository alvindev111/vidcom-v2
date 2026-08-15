import type { DaemonClient } from "@vidcom/adapter";
import { DaemonClientError } from "@vidcom/adapter";
import { ErrorCode } from "@vidcom/contracts";
import type { InputRequest, ToolInvocation, ToolInvoker, ToolRequestContext } from "@vidcom/mcp";

function inputRequestFrom(error: DaemonClientError): InputRequest | null {
  if (error.code !== ErrorCode.ApprovalRequired) return null;
  const candidate = error.details?.inputRequest;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Partial<InputRequest>;
  return typeof value.message === "string"
    && typeof value.requestState === "string"
    && !!value.schema
    && typeof value.schema === "object"
    && !Array.isArray(value.schema)
    ? value as InputRequest
    : null;
}

/**
 * Runs tools on the daemon instead of in this process.
 *
 * This file is the only place that sees both sides, and it lives in `cli`
 * because `cli` is the only package that declares both `@vidcom/adapter` and
 * `@vidcom/mcp`. Putting it in `mcp` would need `mcp` to import `adapter`,
 * which two independent gates refuse — and the path-prefix gate means
 * `adapter/daemon` is still `adapter`, so there is no spelling that escapes it.
 *
 * The bridge forwards identity and never records it: the daemon writes the
 * audit entry, because a bridge that dies mid-call must not take the record of
 * the call with it.
 */
export type DaemonClientSource = DaemonClient | (() => DaemonClient);

/**
 * Accepts a provider as well as a fixed client so a long-lived stdio session can
 * swap to a restarted daemon without rebuilding the negotiated MCP transport.
 */
export function createRemoteToolInvoker(source: DaemonClientSource): ToolInvoker {
  return {
    async invoke(name: string, raw: unknown, request: ToolRequestContext): Promise<ToolInvocation> {
      try {
        const client = typeof source === "function" ? source() : source;
        const result = await client.invokeTool(name, raw, {
          protocolVersion: request.protocolVersion,
          // The bridge negotiated this connection, so it is the side that knows
          // the era. The daemon executing as "modern" regardless would run a
          // modern-only tool for a legacy client.
          era: request.era,
        });
        return { ok: true, value: result };
      } catch (error) {
        if (error instanceof DaemonClientError) {
          const inputRequest = inputRequestFrom(error);
          if (inputRequest) return request.requestInput(inputRequest);
          // The daemon's stable code is carried through unchanged. Collapsing it
          // to one transport error here would hide the difference between a tool
          // that refused the input and a daemon that never answered, which are
          // the two things a caller most needs to tell apart.
          return {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              ...(error.field === undefined ? {} : { field: error.field }),
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          };
        }
        return {
          ok: false,
          error: { code: ErrorCode.DaemonUnavailable, message: "the daemon could not run the tool" },
        };
      }
    },
  };
}
