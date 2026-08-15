import {
  BrowseEntriesRequestSchema,
  CreateDirectoryRequestSchema,
  ErrorCode,
} from "@vidcom/contracts";
import type { FilesystemBrowserService } from "@vidcom/core";
import { Hono } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";

export interface SystemRouteDependencies {
  browser: FilesystemBrowserService;
  /** The session this request belongs to; tokens are bound to it. */
  sessionId(request: Request): string | undefined;
  workspace(): Promise<{ workspaceRoot: string | null }>;
  runtime(): Promise<Record<string, unknown>>;
}

function requireSession(dependencies: SystemRouteDependencies, request: Request): string {
  const sessionId = dependencies.sessionId(request);
  if (!sessionId) {
    throw new HttpBoundaryError({ code: ErrorCode.AuthRequired, message: "a session is required to browse" });
  }
  return sessionId;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } }): T {
  if (result.ok) return result.value;
  throw new HttpBoundaryError({ code: result.error.code, message: result.error.message });
}

function invalid(message: string): never {
  throw new HttpBoundaryError({ code: ErrorCode.SchemaInvalid, message });
}

/**
 * Filesystem navigation for the authenticated UI session.
 *
 * These routes are reachable only over the loopback perimeter and are
 * deliberately absent from the MCP tool surface: an agent able to enumerate the
 * user's filesystem would hold a capability nobody granted it.
 */
export function createSystemRoutes(dependencies: SystemRouteDependencies): Hono {
  const routes = new Hono();

  routes.get("/filesystem/roots", async (c) => {
    const sessionId = requireSession(dependencies, c.req.raw);
    return c.json({ roots: unwrap(await dependencies.browser.roots(sessionId)) });
  });

  routes.post("/filesystem/entries", async (c) => {
    const sessionId = requireSession(dependencies, c.req.raw);
    const parsed = BrowseEntriesRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) invalid("browse entries payload is invalid");
    const input = parsed.data;
    return c.json(unwrap(await dependencies.browser.list({
      sessionId,
      token: input.token,
      ...input.cursor === undefined ? {} : { cursor: input.cursor },
    })));
  });

  routes.post("/directories", async (c) => {
    const sessionId = requireSession(dependencies, c.req.raw);
    const parsed = CreateDirectoryRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) invalid("create directory payload is invalid");
    const input = parsed.data;
    return c.json(unwrap(await dependencies.browser.createDirectory({
      sessionId,
      parentToken: input.parentToken,
      name: input.name,
    })), 201);
  });

  routes.get("/workspace", async (c) => c.json(await dependencies.workspace()));

  routes.get("/runtime", async (c) => c.json(await dependencies.runtime()));

  return routes;
}
