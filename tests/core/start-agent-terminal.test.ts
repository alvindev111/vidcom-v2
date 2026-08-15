import { describe, expect, it } from "vitest";

import { ErrorCode, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  MAX_AGENT_TERMINALS,
  err,
  ok,
  startAgentTerminal,
  type AbsolutePath,
  type AgentTerminalPort,
  type AgentTerminalSession,
  type AgentTerminalSpec,
  type ProjectRef,
  type StartAgentTerminalDependencies,
} from "@vidcom/core";

const MCP_SERVER = {
  name: "vidcom",
  url: "http://127.0.0.1:7788/api/mcp",
  tokenEnvVar: "VIDCOM_MCP_TOKEN",
  token: "secret-bearer",
} as const;

function fakeSession(spec: AgentTerminalSpec): AgentTerminalSession & { resizes: Array<[number, number]> } {
  const resizes: Array<[number, number]> = [];
  return {
    id: `terminal_${spec.projectId}`,
    projectId: spec.projectId,
    agent: spec.agent,
    resizes,
    write() {},
    resize(cols, rows) { resizes.push([cols, rows]); },
    close() {},
    subscribe() { return () => {}; },
  };
}

/**
 * A port that records what it was asked to open, so the test can assert the
 * policy the use case applied rather than the pty library's behaviour.
 */
function fakeTerminals(options: { failOpen?: Error } = {}) {
  const opened: AgentTerminalSpec[] = [];
  const live = new Map<ProjectId, ReturnType<typeof fakeSession>>();
  const port: AgentTerminalPort = {
    async open(spec) {
      if (options.failOpen) throw options.failOpen;
      opened.push(spec);
      const session = fakeSession(spec);
      live.set(spec.projectId, session);
      return session;
    },
    findByProject: (projectId) => live.get(projectId) ?? null,
    find: (sessionId) => [...live.values()].find((session) => session.id === sessionId) ?? null,
    liveCount: () => live.size,
  };
  return { port, opened, live };
}

function fakeWorkspace(known: readonly string[]) {
  return {
    async readProjectRef(id: ProjectId): Promise<ProjectRef | null> {
      return known.includes(id)
        ? { id, slug: "demo", root: `/workspace/${id}` as AbsolutePath, entry: "index.html" as RelPath }
        : null;
    },
  };
}

const WORKSPACE_ROOT = "/workspace" as AbsolutePath;

/** Records which host the kit was installed for, without touching a filesystem. */
function fakeAgentKit(options: { fail?: boolean } = {}) {
  const hosts: string[] = [];
  return {
    hosts,
    async apply(_root: AbsolutePath, input: { hosts?: readonly string[] }) {
      hosts.push(...(input.hosts ?? []));
      return options.fail
        ? err({ code: ErrorCode.StorageUnavailable, message: "workspace is read-only" })
        : ok({} as never);
    },
  };
}

const INPUT = { projectId: "project_1" as ProjectId, agent: "codex" as const, cols: 80, rows: 24 };

function deps(
  workspace: ReturnType<typeof fakeWorkspace>,
  terminals: AgentTerminalPort,
  agentKit: ReturnType<typeof fakeAgentKit> = fakeAgentKit(),
): StartAgentTerminalDependencies {
  return {
    workspace,
    terminals,
    mcpServer: MCP_SERVER,
    workspaceRoot: WORKSPACE_ROOT,
    agentKit: agentKit as unknown as StartAgentTerminalDependencies["agentKit"],
  };
}

describe("startAgentTerminal", () => {
  it("launches the agent in the project directory with the injected MCP server", async () => {
    const terminals = fakeTerminals();
    const result = await startAgentTerminal(
      deps(fakeWorkspace(["project_1"]), terminals.port),
      INPUT,
    );

    expect(result.ok).toBe(true);
    expect(terminals.opened).toEqual([{
      projectId: "project_1",
      agent: "codex",
      cwd: "/workspace/project_1",
      cols: 80,
      rows: 24,
      mcpServer: MCP_SERVER,
    }]);
  });

  it("re-attaches to a running session and resizes it instead of starting a second agent", async () => {
    const terminals = fakeTerminals();
    const dependencies = deps(fakeWorkspace(["project_1"]), terminals.port);
    await startAgentTerminal(dependencies, INPUT);
    const again = await startAgentTerminal(dependencies, { ...INPUT, cols: 120, rows: 40 });

    expect(again.ok && again.value.reattached).toBe(true);
    expect(terminals.opened).toHaveLength(1);
    expect(terminals.live.get("project_1" as ProjectId)?.resizes).toEqual([[120, 40]]);
  });

  it("rejects a project that does not exist before spawning anything", async () => {
    const terminals = fakeTerminals();
    const result = await startAgentTerminal(
      deps(fakeWorkspace([]), terminals.port),
      INPUT,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe(ErrorCode.ProjectNotFound);
    expect(terminals.opened).toHaveLength(0);
  });

  it("refuses to cross the concurrent-terminal ceiling", async () => {
    const terminals = fakeTerminals();
    const known = Array.from({ length: MAX_AGENT_TERMINALS + 1 }, (_, index) => `project_${index}`);
    const dependencies = deps(fakeWorkspace(known), terminals.port);
    for (let index = 0; index < MAX_AGENT_TERMINALS; index += 1) {
      const opened = await startAgentTerminal(dependencies, { ...INPUT, projectId: `project_${index}` as ProjectId });
      expect(opened.ok).toBe(true);
    }

    const refused = await startAgentTerminal(dependencies, {
      ...INPUT,
      projectId: `project_${MAX_AGENT_TERMINALS}` as ProjectId,
    });

    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error.code).toBe(ErrorCode.AgentSessionLimit);
  });

  it("installs the agent kit for the host being launched, before the spawn", async () => {
    // Without it the agent has no instruction file, does not know VidCom's tools
    // exist, and asks the user to pick a video format for a project that already
    // declares one instead of calling `get_project_context`.
    const terminals = fakeTerminals();
    const kit = fakeAgentKit();
    await startAgentTerminal(deps(fakeWorkspace(["project_1"]), terminals.port, kit), INPUT);

    expect(kit.hosts).toEqual(["codex"]);
  });

  it("installs the Claude Code kit when that is the agent", async () => {
    const terminals = fakeTerminals();
    const kit = fakeAgentKit();
    await startAgentTerminal(
      deps(fakeWorkspace(["project_1"]), terminals.port, kit),
      { ...INPUT, agent: "claude" },
    );

    expect(kit.hosts).toEqual(["claude-code"]);
  });

  it("still opens the terminal when the kit cannot be written", async () => {
    // A read-only workspace costs the agent its orientation, not the user their
    // terminal.
    const terminals = fakeTerminals();
    const result = await startAgentTerminal(
      deps(fakeWorkspace(["project_1"]), terminals.port, fakeAgentKit({ fail: true })),
      INPUT,
    );

    expect(result.ok).toBe(true);
    expect(terminals.opened).toHaveLength(1);
  });

  it("reports a missing agent CLI as agent_unavailable rather than throwing", async () => {
    const terminals = fakeTerminals({ failOpen: new Error("spawn codex ENOENT") });
    const result = await startAgentTerminal(
      deps(fakeWorkspace(["project_1"]), terminals.port),
      INPUT,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe(ErrorCode.AgentUnavailable);
    expect(result.ok === false && result.error.details?.cause).toContain("ENOENT");
  });
});
