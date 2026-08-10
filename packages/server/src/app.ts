import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";

import type { NonceSource } from "./auth/nonce";
import type { DomainError } from "@vidcom/contracts";
import type { Result, SessionPort } from "@vidcom/core";
import type { EventOutboxPort, JobStorePort } from "@vidcom/core";
import { mapHttpError, HttpBoundaryError } from "./middleware/error-mapper";
import {
  hostCheck,
  mcpBearerAuth,
  requestId,
  requestLogger,
  sessionAuth,
  strictCors,
  type McpAuthEnv,
  type McpCredentialVerifier,
} from "./middleware/perimeter";
import { createAgentTerminalRoutes, type AgentTerminalRouteDependencies } from "./routes/agent-terminal";
import { createAuthRoutes } from "./routes/auth";
import { createProjectReadRoutes, type ProjectReadRouteDependencies } from "./routes/project-reads";
import { createJobRoutes } from "./routes/jobs";
import { createNarrationRoutes, type NarrationRouteDependencies } from "./routes/narration";
import { createEventRoutes } from "./routes/events";
import { createProjectWriteRoutes, type ProjectWriteRouteDependencies } from "./routes/project-writes";
import { createBridgeRoutes, type BridgeRouteDependencies } from "./routes/bridge";
import { createMcpRoutes, type McpRouteDependencies } from "./routes/mcp";
import { createSystemRoutes, type SystemRouteDependencies } from "./routes/system";
import { createDeliveryLoopRoutes, type DeliveryLoopRouteDependencies } from "./routes/delivery-loop";
import { ActivateWorkspaceRequestSchema, ErrorCode, MAX_BGM_BYTES, MAX_SOURCE_BYTES } from "@vidcom/contracts";

export interface ServerAppDependencies {
  port: number;
  uiOrigins: readonly string[];
  nonces: NonceSource;
  sessions: SessionPort;
  mcpCredentials?: McpCredentialVerifier;
  mcp?: McpRouteDependencies;
  bridge?: BridgeRouteDependencies;
  system?: SystemRouteDependencies;
  log?: (line: string) => void;
  trace?: (step: string) => void;
  projectReads?: ProjectReadRouteDependencies;
  jobs?: JobStorePort;
  events?: EventOutboxPort;
  projectWrites?: ProjectWriteRouteDependencies;
  narration?: NarrationRouteDependencies;
  deliveryLoop?: DeliveryLoopRouteDependencies;
  agentTerminal?: AgentTerminalRouteDependencies;
  /** Bootstrap-only workspace activation; active runtimes use `deliveryLoop`. */
  workspaceActivation?(selectionToken: string): Promise<Result<{
    workspaceRoot: string;
    reauthRequired: true;
  }, DomainError>>;
}

function observed(step: string, middleware: ReturnType<typeof requestId>, trace?: (step: string) => void) {
  return async (...args: Parameters<typeof middleware>) => {
    trace?.(step);
    return middleware(...args);
  };
}

function bodyTooLarge(): never {
  throw new HttpBoundaryError({ code: ErrorCode.TooLarge, message: "request body is too large" });
}

export function createServerApp(deps: ServerAppDependencies) {
  const app = new Hono<McpAuthEnv>().basePath("/api");
  const register = (step: string, middleware: ReturnType<typeof requestId>) =>
    app.use("*", observed(step, middleware, deps.trace));

  register("requestId", requestId());
  register("logger", requestLogger(deps.log ?? (() => {})));
  register("hostCheck", hostCheck(deps.port));
  register("cors", strictCors(deps.uiOrigins));
  const browserAuth = sessionAuth(deps.sessions);
  const mcpAuth = mcpBearerAuth(deps.mcpCredentials ?? { verify: async () => null });
  // The bridge authenticates the same way MCP does — a bearer, not a browser
  // session — because the client is an agent host, not a page. Which bearer is
  // acceptable there is narrower, and the bridge routes enforce that
  // themselves.
  app.use("*", observed("auth", (c, next) => c.req.path.startsWith("/api/mcp")
    || c.req.path.startsWith("/api/bridge")
    ? mcpAuth(c, next)
    : browserAuth(c, next), deps.trace));
  const limits = {
    regular: bodyLimit({ maxSize: 1_048_576, onError: bodyTooLarge }),
    source: bodyLimit({ maxSize: MAX_SOURCE_BYTES + 65_536, onError: bodyTooLarge }),
    bgm: bodyLimit({ maxSize: MAX_BGM_BYTES + 65_536, onError: bodyTooLarge }),
  };
  app.use("*", observed("bodyLimit", async (c, next) => {
    const pathname = c.req.path;
    const limiter = /\/v1\/projects\/[^/]+\/files$/.test(pathname)
      ? limits.source
      : /\/v1\/projects\/[^/]+\/assets\/bgm$/.test(pathname)
        ? limits.bgm
        : limits.regular;
    return limiter(c, next);
  }, deps.trace));

  app.route("/v1", createAuthRoutes(deps.nonces, deps.sessions, deps.trace));
  if (deps.mcp) app.route("/", createMcpRoutes(deps.mcp));
  if (deps.bridge) app.route("/", createBridgeRoutes(
    deps.bridge,
    deps.deliveryLoop ? {
      enqueueRender: deps.deliveryLoop.enqueueRender,
      jobs: deps.deliveryLoop.jobs,
    } : undefined,
  ));
  // Under /v1/system, behind the same session the browser already holds. The
  // picker is the only caller, and an agent that could enumerate the user's
  // filesystem would hold a capability nobody granted it.
  if (deps.system) app.route("/v1/system", createSystemRoutes(deps.system));
  if (deps.projectReads) app.route("/", createProjectReadRoutes(deps.projectReads));
  if (deps.jobs) app.route("/v1", createJobRoutes(deps.jobs));
  if (deps.events) app.route("/v1", createEventRoutes(deps.events));
  if (deps.projectWrites) app.route("/", createProjectWriteRoutes(deps.projectWrites));
  if (deps.narration) app.route("/", createNarrationRoutes(deps.narration));
  if (deps.deliveryLoop) app.route("/", createDeliveryLoopRoutes(deps.deliveryLoop));
  if (deps.agentTerminal) app.route("/", createAgentTerminalRoutes(deps.agentTerminal));
  if (deps.workspaceActivation) app.put("/v1/workspace/active", async (c) => {
    const parsed = ActivateWorkspaceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpBoundaryError({ code: ErrorCode.SchemaInvalid, message: "workspace activation payload is invalid" });
    }
    const activated = await deps.workspaceActivation!(parsed.data.selectionToken);
    if (!activated.ok) throw new HttpBoundaryError(activated.error);
    return c.json(activated.value);
  });
  app.get("/v1/health", (c) => c.json({ ok: true }));
  app.notFound((c) => mapHttpError(
    new HttpBoundaryError({ code: ErrorCode.NotFound, message: "endpoint not found" }),
    c,
  ));
  app.onError((error, c) => {
    deps.trace?.("errorMapper");
    return mapHttpError(error, c);
  });
  return app;
}
