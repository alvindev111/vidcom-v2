import type { McpServerDescriptor } from "@vidcom/core";

/** The MCP server name agent terminals are launched with. */
export const AGENT_MCP_SERVER_NAME = "vidcom";

/** Label the terminal's own MCP credential is issued under, so `credential list` can tell it apart. */
export const AGENT_MCP_CREDENTIAL_LABEL = "agent:terminal";

/**
 * Environment variable both agent CLIs read the bearer from.
 *
 * `VIDCOM_`-prefixed like the rest of this daemon's wiring, which also means the
 * pty adapter's own environment filter would strip it — that adapter re-adds it
 * after filtering for exactly this value.
 */
export const AGENT_MCP_TOKEN_ENV_VAR = "VIDCOM_MCP_TOKEN";

export interface AgentMcpCredentialIssuer {
  issue(label: string): Promise<{ id: string; secret: string }>;
}

/**
 * Points agent terminals at this daemon's own MCP endpoint, with a credential
 * of their own.
 *
 * A fresh credential per daemon start rather than the system bridge bearer: the
 * agent is a user-level MCP client, and giving it the bearer the daemon uses for
 * its own bridge would make one revocation cut both. The secret is returned once
 * and held in memory — it is never written to the workspace, a log, or argv.
 */
export async function agentMcpServer(
  credentials: AgentMcpCredentialIssuer,
  port: number,
): Promise<McpServerDescriptor> {
  const issued = await credentials.issue(AGENT_MCP_CREDENTIAL_LABEL);
  return {
    name: AGENT_MCP_SERVER_NAME,
    // 127.0.0.1, not localhost: the daemon's own host check names both, but the
    // literal address cannot be re-pointed by a hosts file or a resolver.
    url: `http://127.0.0.1:${port}/api/mcp`,
    tokenEnvVar: AGENT_MCP_TOKEN_ENV_VAR,
    token: issued.secret,
  };
}
