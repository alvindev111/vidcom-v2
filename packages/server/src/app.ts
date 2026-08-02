import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";

import type { NonceSource } from "./auth/nonce";
import type { SessionPort } from "@vidcom/core";
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
import { createAuthRoutes } from "./routes/auth";
import { createProjectReadRoutes, type ProjectReadRouteDependencies } from "./routes/project-reads";
import { createJobRoutes } from "./routes/jobs";
import { createEventRoutes } from "./routes/events";
import { createProjectWriteRoutes, type ProjectWriteRouteDependencies } from "./routes/project-writes";
import { createMcpRoutes, type McpRouteDependencies } from "./routes/mcp";
import { ErrorCode, MAX_BGM_BYTES, MAX_SOURCE_BYTES } from "@vidcom/contracts";

export interface ServerAppDependencies {
  port: number;
  uiOrigins: readonly string[];
  nonces: NonceSource;
  sessions: SessionPort;
  mcpCredentials?: McpCredentialVerifier;
  mcp?: McpRouteDependencies;
  log?: (line: string) => void;
  trace?: (step: string) => void;
  projectReads?: ProjectReadRouteDependencies;
  jobs?: JobStorePort;
  events?: EventOutboxPort;
  projectWrites?: ProjectWriteRouteDependencies;
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
  app.use("*", observed("auth", (c, next) => c.req.path.startsWith("/api/mcp")
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
  if (deps.projectReads) app.route("/", createProjectReadRoutes(deps.projectReads));
  if (deps.jobs) app.route("/v1", createJobRoutes(deps.jobs));
  if (deps.events) app.route("/v1", createEventRoutes(deps.events));
  if (deps.projectWrites) app.route("/", createProjectWriteRoutes(deps.projectWrites));
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
