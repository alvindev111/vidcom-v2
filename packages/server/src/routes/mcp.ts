import { Hono, type Context } from "hono";

import type { McpAuthEnv } from "../middleware/perimeter";

export interface McpRouteAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
}

export interface McpRouteDependencies {
  handlers: ReadonlyMap<string, (
    request: Request,
    options?: { authInfo?: McpRouteAuthInfo },
  ) => Promise<Response>>;
  defaultRevision: string;
}

/** Mounts the MCP entry and revision-addressed SDK handlers without importing the MCP package. */
export function createMcpRoutes(dependencies: McpRouteDependencies): Hono<McpAuthEnv> {
  const routes = new Hono<McpAuthEnv>();
  const dispatch = (key: string) => async (context: Context<McpAuthEnv>) => {
    const handler = dependencies.handlers.get(key);
    if (!handler) return new Response("MCP revision handler unavailable", { status: 500 });
    return handler(context.req.raw, {
      authInfo: {
        token: "",
        clientId: context.get("credentialId"),
        scopes: [],
      },
    });
  };
  routes.all("/mcp", dispatch(""));
  routes.all("/mcp/:revision", (context) => dispatch(context.req.param("revision"))(context));
  return routes;
}
