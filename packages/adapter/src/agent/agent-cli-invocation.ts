import path from "node:path";

import type { AgentId } from "@vidcom/contracts";
import type { McpServerDescriptor } from "@vidcom/core";

/** One agent CLI launch, with the config file and environment it needs. */
export interface AgentInvocation {
  /** Executable name, resolved through PATH by the spawn layer rather than by us. */
  command: string;
  args: string[];
  /** Written before the spawn and removed after the session ends; `null` when the CLI takes its config on argv. */
  configFile: { path: string; contents: string } | null;
  /** Layered on top of the inherited environment; carries the bearer, which argv must never hold. */
  environment: Record<string, string>;
}

/**
 * Encodes one string as a TOML basic string.
 *
 * Basic rather than literal (`'…'`): Codex parses `-c` values as TOML, and a
 * literal string cannot contain a quote at all. Escaping both characters is
 * total, where picking the quoting style per value is a decision that fails on
 * the one value nobody tested.
 */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * The command line that launches one agent CLI already pointed at VidCom's MCP
 * server, with the bearer passed through the environment.
 *
 * Two CLIs, two mechanisms, and the difference is theirs rather than ours.
 * Claude Code reads MCP servers from a JSON file named on argv, and expands
 * `${VAR}` inside it — so the file names the variable and never holds the
 * secret. `--strict-mcp-config` is added with it: without it the session also
 * loads whatever the user configured globally, and a project terminal silently
 * carrying a stranger's servers is not what this offers. Codex takes `-c`
 * dotted-path overrides and has `bearer_token_env_var` for exactly this reason;
 * relocating `CODEX_HOME` instead would also relocate the user's stored login.
 *
 * Nothing is interpolated into a shell string: every element stays a separate
 * argv entry, and the token appears in neither ([09-security](../../../../llm-documents/steering/09-security.md) §8).
 */
export function agentInvocation(input: {
  agent: AgentId;
  mcpServer: McpServerDescriptor;
  /** Directory that owns generated config files; MUST be outside the user's workspace. */
  configDirectory: string;
  sessionId: string;
}): AgentInvocation {
  const environment = { [input.mcpServer.tokenEnvVar]: input.mcpServer.token };

  if (input.agent === "claude") {
    const configPath = path.join(input.configDirectory, `${input.sessionId}.mcp.json`);
    return {
      command: "claude",
      args: ["--mcp-config", configPath, "--strict-mcp-config"],
      configFile: {
        path: configPath,
        contents: `${JSON.stringify({
          mcpServers: {
            [input.mcpServer.name]: {
              type: "http",
              url: input.mcpServer.url,
              headers: { Authorization: `Bearer \${${input.mcpServer.tokenEnvVar}}` },
            },
          },
        }, null, 2)}\n`,
      },
      environment,
    };
  }

  const key = `mcp_servers.${input.mcpServer.name}`;
  return {
    command: "codex",
    args: [
      "-c", `${key}.url=${tomlBasicString(input.mcpServer.url)}`,
      "-c", `${key}.bearer_token_env_var=${tomlBasicString(input.mcpServer.tokenEnvVar)}`,
    ],
    configFile: null,
    environment,
  };
}
