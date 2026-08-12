import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProjectId } from "@vidcom/contracts";
import { NodePtyAgentTerminals, agentInvocation, consoleLaunchPlan } from "@vidcom/adapter";

const MCP_SERVER = {
  name: "vidcom",
  url: "http://127.0.0.1:7788/api/mcp",
  tokenEnvVar: "VIDCOM_MCP_TOKEN",
  token: "secret-bearer",
} as const;

/** A command every runner has that prints one line and exits on its own. */
function harmlessCommand(): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "cmd.exe", args: ["/c", "echo VIDCOM_PTY_OK"] }
    : { command: "/bin/sh", args: ["-c", "echo VIDCOM_PTY_OK"] };
}

describe("agentInvocation", () => {
  it("hands Claude Code a strict config file naming the server", () => {
    const invocation = agentInvocation({
      agent: "claude",
      mcpServer: MCP_SERVER,
      configDirectory: "/app-data/agent-terminals",
      sessionId: "terminal_1",
    });

    expect(invocation.command).toBe("claude");
    expect(invocation.args).toEqual([
      "--mcp-config", path.join("/app-data/agent-terminals", "terminal_1.mcp.json"),
      "--strict-mcp-config",
    ]);
    // The variable name, not the secret: the file lives on disk, so the token
    // must reach the agent through the environment instead.
    expect(JSON.parse(invocation.configFile?.contents ?? "null")).toEqual({
      mcpServers: {
        vidcom: {
          type: "http",
          url: "http://127.0.0.1:7788/api/mcp",
          headers: { Authorization: "Bearer ${VIDCOM_MCP_TOKEN}" },
        },
      },
    });
    expect(invocation.configFile?.contents).not.toContain("secret-bearer");
    expect(invocation.environment).toEqual({ VIDCOM_MCP_TOKEN: "secret-bearer" });
  });

  it("gives Codex TOML overrides that name the token variable and never the token", () => {
    const invocation = agentInvocation({
      agent: "codex",
      mcpServer: MCP_SERVER,
      configDirectory: "/app-data/agent-terminals",
      sessionId: "terminal_1",
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.configFile).toBeNull();
    expect(invocation.args).toEqual([
      "-c", 'mcp_servers.vidcom.url="http://127.0.0.1:7788/api/mcp"',
      "-c", 'mcp_servers.vidcom.bearer_token_env_var="VIDCOM_MCP_TOKEN"',
    ]);
    expect(invocation.args.join(" ")).not.toContain("secret-bearer");
    expect(invocation.environment).toEqual({ VIDCOM_MCP_TOKEN: "secret-bearer" });
  });

  it("escapes a quote in the server URL rather than closing the TOML string", () => {
    const invocation = agentInvocation({
      agent: "codex",
      mcpServer: { ...MCP_SERVER, url: 'http://127.0.0.1/"weird' },
      configDirectory: "/app-data/agent-terminals",
      sessionId: "terminal_1",
    });

    expect(invocation.args[1]).toBe('mcp_servers.vidcom.url="http://127.0.0.1/\\"weird"');
  });
});

describe("consoleLaunchPlan", () => {
  const args = ["-c", 'mcp_servers.vidcom.url="http://127.0.0.1:7788/api/mcp"'];
  // `NodeJS.ProcessEnv` is augmented to require NODE_ENV in this repo, and these
  // cases are about COMSPEC alone.
  const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

  it("runs the agent unwrapped where there is no console code page", () => {
    expect(consoleLaunchPlan("/usr/local/bin/codex", args, env({}), "darwin")).toEqual({
      command: "/usr/local/bin/codex",
      args,
    });
  });

  it("sets the console to UTF-8 before the agent starts on Windows", () => {
    const plan = consoleLaunchPlan("C:\\bin\\codex.exe", args, env({ COMSPEC: "C:\\WINDOWS\\cmd.exe" }), "win32");

    expect(plan.command).toBe("C:\\WINDOWS\\cmd.exe");
    expect(plan.args).toEqual([
      "/d", "/c", "chcp", "65001", ">nul", "&",
      "C:\\bin\\codex.exe",
      ...args,
    ]);
  });

  it("quotes a path whose account name carries a cmd separator", () => {
    // `C:\Users\A&B\…` is a real account name shape, and unquoted it would end
    // the command at the ampersand and run the rest as a second one.
    const plan = consoleLaunchPlan(
      "C:\\bin\\claude.exe",
      ["--mcp-config", "C:\\Users\\A&B\\AppData\\vidcom.json"],
      env({ COMSPEC: "cmd.exe" }),
      "win32",
    );

    expect(plan.args).toContain('"C:\\Users\\A&B\\AppData\\vidcom.json"');
    expect(plan.args).toContain("--mcp-config");
  });

  it("leaves a TOML assignment alone, since it holds no cmd syntax", () => {
    const plan = consoleLaunchPlan("C:\\bin\\codex.exe", args, env({}), "win32");

    expect(plan.args).toContain('mcp_servers.vidcom.url="http://127.0.0.1:7788/api/mcp"');
  });
});

describe("NodePtyAgentTerminals", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vidcom-terminal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function spec(projectId: string) {
    return {
      projectId: projectId as ProjectId,
      agent: "codex" as const,
      cwd: root,
      cols: 80,
      rows: 24,
      mcpServer: MCP_SERVER,
    };
  }

  it("loads the required native binding only when a terminal is opened", async () => {
    let loads = 0;
    const terminals = new NodePtyAgentTerminals(path.join(root, "config"), {
      invocationFor: () => ({ ...harmlessCommand(), configFile: null, environment: {} }),
      loadRuntime: async () => {
        loads += 1;
        throw new Error("fixture binding is absent");
      },
    });

    expect(terminals.liveCount()).toBe(0);
    expect(loads).toBe(0);
    await expect(terminals.open(spec("project_native_missing")))
      .rejects.toThrow(/required node-pty native runtime is unavailable/u);
    expect(loads).toBe(1);
  });

  /**
   * A real pty running a real command: the point of this adapter is that a pty
   * behaves differently from a pipe, so the native binding, the output and the
   * terminal exit frame are all exercised for real.
   */
  it("streams a real process's output and its exit frame, then stops counting it", async () => {
    const terminals = new NodePtyAgentTerminals(path.join(root, "config"), {
      invocationFor: () => ({ ...harmlessCommand(), configFile: null, environment: {} }),
    });
    const session = await terminals.open(spec("project_1"));
    expect(terminals.liveCount()).toBe(1);
    expect(terminals.findByProject("project_1" as ProjectId)).toBe(session);

    let output = "";
    const exitCode = await new Promise<number | null>((resolve) => {
      session.subscribe((frame) => {
        if (frame.type === "data") output += frame.data;
        else resolve(frame.exitCode);
      });
    });

    expect(output).toContain("VIDCOM_PTY_OK");
    expect(exitCode).toBe(0);
    // An ended session leaves the live set, so re-attaching starts a new agent
    // rather than handing back a dead one.
    expect(terminals.findByProject("project_1" as ProjectId)).toBeNull();
    expect(terminals.liveCount()).toBe(0);
  }, 30_000);

  it("replays everything already printed to a subscriber that attaches late", async () => {
    const terminals = new NodePtyAgentTerminals(path.join(root, "config"), {
      invocationFor: () => ({ ...harmlessCommand(), configFile: null, environment: {} }),
    });
    const session = await terminals.open(spec("project_2"));
    await new Promise<void>((resolve) => {
      session.subscribe((frame) => { if (frame.type === "exit") resolve(); });
    });

    let replayed = "";
    session.subscribe((frame) => { if (frame.type === "data") replayed += frame.data; });

    expect(replayed).toContain("VIDCOM_PTY_OK");
  }, 30_000);

  it("writes the generated config before the spawn and removes it once the session ends", async () => {
    const configDirectory = path.join(root, "config");
    const harmless = harmlessCommand();
    const terminals = new NodePtyAgentTerminals(configDirectory, {
      invocationFor: (input) => ({
        ...harmless,
        configFile: {
          path: path.join(configDirectory, `${input.sessionId}.mcp.json`),
          contents: JSON.stringify({ mcpServers: { vidcom: { url: "http://x" } } }),
        },
        environment: {},
      }),
    });
    const session = await terminals.open(spec("project_3"));
    const configPath = path.join(configDirectory, `${session.id}.mcp.json`);

    const ended = new Promise<void>((resolve) => {
      session.subscribe((frame) => { if (frame.type === "exit") resolve(); });
    });
    await ended;
    // The removal is fire-and-forget on the exit path, so the assertion waits
    // for the microtask that owns it rather than racing it.
    await new Promise((settle) => setTimeout(settle, 200));

    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  }, 30_000);

  it("strips VIDCOM_ internals but still delivers the invocation's own token", async () => {
    const probe = process.platform === "win32"
      ? {
          command: "cmd.exe",
          args: ["/c", "echo [%VIDCOM_BOOTSTRAP_NONCE%][%AGENT_PROBE%][%VIDCOM_MCP_TOKEN%]"],
        }
      : {
          command: "/bin/sh",
          args: ["-c", "echo \"[$VIDCOM_BOOTSTRAP_NONCE][$AGENT_PROBE][$VIDCOM_MCP_TOKEN]\""],
        };
    const terminals = new NodePtyAgentTerminals(path.join(root, "config"), {
      environment: { ...process.env, VIDCOM_BOOTSTRAP_NONCE: "leaked-nonce", AGENT_PROBE: "kept" },
      invocationFor: () => ({ ...probe, configFile: null, environment: { VIDCOM_MCP_TOKEN: "the-bearer" } }),
    });
    const session = await terminals.open(spec("project_4"));

    let output = "";
    await new Promise<void>((resolve) => {
      session.subscribe((frame) => {
        if (frame.type === "data") output += frame.data;
        else resolve();
      });
    });

    expect(output).not.toContain("leaked-nonce");
    expect(output).toContain("kept");
    // The filter runs before the invocation's own variables are layered on, so
    // a `VIDCOM_`-prefixed token survives while the daemon's internals do not.
    expect(output).toContain("the-bearer");
  }, 30_000);
});
