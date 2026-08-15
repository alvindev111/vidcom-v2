import { Hono } from "hono";

import { ErrorCode, TOOL_SCHEMA_CATALOGUE, type ErrorDetail } from "@vidcom/contracts";
import type { JobStorePort } from "@vidcom/core";

import type { AttachmentKind, AttachmentRegistry } from "../bridge/attachments";
import { HttpBoundaryError } from "../middleware/error-mapper";
import type { McpAuthEnv } from "../middleware/perimeter";
import { enqueueRenderResponse, type DeliveryLoopRouteDependencies } from "./delivery-loop";
import { jobId, publicJob, requestJobCancellation, requireJob } from "./jobs";

export interface BridgeToolRequest {
  name: string;
  input: unknown;
  protocolVersion: string;
  era: "legacy" | "modern";
  requestState?: unknown;
  credentialId: string;
}

export interface BridgeRouteDependencies {
  instanceId: string;
  workspaceRoot: string;
  daemonVersion: string;
  protocolVersions: readonly string[];
  attachments: AttachmentRegistry;
  /** The system bridge credential recorded in `app_settings`. */
  bridgeCredentialId(): Promise<string | null>;
  leaseHeld(): boolean | Promise<boolean>;
  /** The daemon's local invoker. It owns the audit entry, not the bridge. */
  invokeTool(request: BridgeToolRequest): Promise<{ ok: true; value: unknown } | {
    ok: false;
    error: ErrorDetail;
  }>;
}

export interface BridgeRenderRouteDependencies {
  enqueueRender: DeliveryLoopRouteDependencies["enqueueRender"];
  jobs: JobStorePort;
}

const ATTACHMENT_KINDS = new Set<AttachmentKind>(["bridge", "ui", "render"]);

function reject(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new HttpBoundaryError({ code, message, details });
}

/**
 * The daemon side of the bridge.
 *
 * Only the system bridge credential reaches these routes. A user MCP
 * credential is a perfectly valid bearer for `/api/mcp`, and letting one
 * through here would hand any configured agent the daemon's own lifecycle
 * controls — attach, detach, and the right to keep it alive.
 */
export function createBridgeRoutes(
  dependencies: BridgeRouteDependencies,
  render?: BridgeRenderRouteDependencies,
): Hono<McpAuthEnv> {
  const routes = new Hono<McpAuthEnv>();

  // Scoped to the bridge prefix, not `*`. This router is mounted at the root of
  // the API app, so a `*` guard would demand the system bridge credential on
  // every browser request in the product — which fails as a 503 that has
  // nothing to do with the route being called.
  routes.use("/bridge/v1/*", async (c, next) => {
    const expected = await dependencies.bridgeCredentialId();
    if (expected === null) {
      reject(ErrorCode.BridgeCredentialUnavailable, "the daemon has no system bridge credential");
    }
    if (c.get("credentialId") !== expected) {
      reject(ErrorCode.BridgeCredentialInvalid, "this credential is not the system bridge credential");
    }
    await next();
  });

  routes.post("/bridge/v1/handshake", async (c) => {
    const body = await c.req.json() as { workspaceRoot?: unknown; expectedInstanceId?: unknown };
    // Both are compared before anything else happens. A live PID on a live port
    // proves only that something is listening — and after a restart the thing
    // listening is a different daemon that will answer every later call
    // convincingly.
    if (body.workspaceRoot !== dependencies.workspaceRoot
      || body.expectedInstanceId !== dependencies.instanceId) {
      reject(ErrorCode.DaemonIdentityMismatch, "this daemon is not the one the client expected", {
        workspaceRoot: dependencies.workspaceRoot,
        instanceId: dependencies.instanceId,
      });
    }
    return c.json({
      workspaceRoot: dependencies.workspaceRoot,
      instanceId: dependencies.instanceId,
      protocolVersions: dependencies.protocolVersions,
      daemonVersion: dependencies.daemonVersion,
    });
  });

  routes.get("/bridge/v1/ready", async (c) => c.json({
    instanceId: dependencies.instanceId,
    workspaceRoot: dependencies.workspaceRoot,
    // Discovery validates against this rather than against `/v1/health`: a
    // process can be alive and answering while holding no workspace lease, and
    // a client that attaches to it gets a daemon that cannot write.
    leaseHeld: await dependencies.leaseHeld(),
  }));

  routes.post("/bridge/v1/attachments", async (c) => {
    const body = await c.req.json() as { kind?: unknown };
    if (typeof body.kind !== "string" || !ATTACHMENT_KINDS.has(body.kind as AttachmentKind)) {
      reject(ErrorCode.SchemaInvalid, "attachment kind is not one this daemon issues");
    }
    return c.json(dependencies.attachments.attach({
      kind: body.kind as AttachmentKind,
      credentialId: c.get("credentialId"),
    }));
  });

  routes.put("/bridge/v1/attachments/:id", (c) => {
    const renewed = dependencies.attachments.renew(c.req.param("id"), c.get("credentialId"));
    // Gone rather than refused: an attachment that expired while its client was
    // stalled is not an authorization problem, and telling the client to attach
    // again is the only useful answer.
    if (!renewed) reject(ErrorCode.NotFound, "attachment is no longer registered");
    return c.json(renewed);
  });

  routes.delete("/bridge/v1/attachments/:id", (c) => {
    dependencies.attachments.detach(c.req.param("id"), c.get("credentialId"));
    // Detaching something already gone is the state the caller wanted.
    return c.body(null, 204);
  });

  if (render) {
    routes.post("/bridge/v1/projects/:id/renders", (c) => enqueueRenderResponse(render, c));
    routes.get("/bridge/v1/jobs/:jobId", async (c) =>
      c.json(publicJob(await requireJob(render.jobs, jobId(c)))));
    routes.post("/bridge/v1/jobs/:jobId/cancel", async (c) => {
      await requestJobCancellation(render.jobs, jobId(c));
      return c.body(null, 204);
    });
  }

  routes.post("/bridge/v1/tools/:name", async (c) => {
    const name = c.req.param("name");
    // Checked against the published catalogue before anything else. Forwarding
    // an unknown name would let the bridge address whatever the daemon happens
    // to have registered, which is the allowlist existing in name only.
    if (!Object.hasOwn(TOOL_SCHEMA_CATALOGUE, name)) {
      reject(ErrorCode.NotFound, "tool is not registered", { tool: name });
    }
    const body = await c.req.json() as {
      input?: unknown;
      protocolVersion?: unknown;
      era?: unknown;
      requestState?: unknown;
    };
    if (typeof body.protocolVersion !== "string") {
      reject(ErrorCode.SchemaInvalid, "protocolVersion is required", { field: "protocolVersion" });
    }
    // Required, not defaulted. Defaulting to "modern" would silently run a
    // modern-only tool for a legacy client, which is the one thing the era
    // split exists to prevent.
    if (body.era !== "legacy" && body.era !== "modern") {
      reject(ErrorCode.SchemaInvalid, "era must be legacy or modern", { field: "era" });
    }

    const result = await dependencies.invokeTool({
      name,
      input: body.input,
      protocolVersion: body.protocolVersion,
      era: body.era,
      requestState: body.requestState,
      // Forwarded, never invented here. The daemon writes the audit entry, so a
      // bridge that dies mid-call cannot take the record of the call with it.
      credentialId: c.get("credentialId"),
    });
    // Preserve the domain payload verbatim. In particular, write conflicts
    // carry `details.current`, and an approval-required result carries the
    // InputRequest the stdio side must turn into MCP elicitation.
    if (!result.ok) throw new HttpBoundaryError(result.error);
    return c.json(result.value ?? null);
  });

  return routes;
}
