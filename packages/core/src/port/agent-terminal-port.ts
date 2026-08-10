import type { AgentId, AgentTerminalFrame, ProjectId } from "@vidcom/contracts";

/**
 * The MCP server an agent session is pointed at, named without saying how any
 * particular CLI is told about it.
 *
 * The daemon's own streamable-HTTP endpoint, not a `vidcom mcp` child. A stdio
 * server owns the workspace lease, and the daemon that spawned this agent is
 * already holding it — so a spawned one fails to start and the agent reports a
 * server with no tools. Going over HTTP also means the agent's calls land in the
 * same registry, audit trail and credential check an external AI host gets.
 */
export interface McpServerDescriptor {
  name: string;
  url: string;
  /**
   * Environment variable the agent reads its bearer from.
   *
   * Never argv: a token on a command line is visible to every process listing on
   * the machine ([09-security](../../../../llm-documents/steering/09-security.md) §8).
   */
  tokenEnvVar: string;
  token: string;
}

/** Everything an adapter needs to launch one agent CLI under a pseudo-terminal. */
export interface AgentTerminalSpec {
  projectId: ProjectId;
  agent: AgentId;
  /** Absolute project directory; the agent's working root, so it edits this project and no other. */
  cwd: string;
  cols: number;
  rows: number;
  mcpServer: McpServerDescriptor;
}

/** One live agent CLI, addressed without exposing the pty handle behind it. */
export interface AgentTerminalSession {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly agent: AgentId;
  /** Sends keystrokes or pasted text to the agent's stdin; a closed session ignores the write. */
  write(data: string): void;
  /** Tells the agent its viewport changed, so full-screen TUIs redraw at the new size. */
  resize(cols: number, rows: number): void;
  /**
   * Terminates the agent and its process tree, then settles the exit listener.
   *
   * Idempotent: closing an already-exited session is a no-op, because the UI
   * closes on unmount and the process may have exited on its own first.
   */
  close(): void;
  /**
   * Streams output and the single terminal exit frame, replaying everything
   * produced since the session started.
   *
   * Replay is the point: the browser attaches over a second HTTP request, so
   * without it the banner an agent prints on startup is lost between the POST
   * that opened the session and the stream that reads it. Returns the
   * unsubscribe function.
   */
  subscribe(listener: (frame: AgentTerminalFrame) => void): () => void;
}

/** Pseudo-terminal seam so Core can run agent CLIs without importing a pty binding. */
export interface AgentTerminalPort {
  /**
   * Launches one agent CLI under a pty and registers the session.
   *
   * Throws only when the executable cannot be started at all — a missing
   * `claude` on PATH, or a pty layer that refused. An agent that starts and then
   * exits non-zero is a normal session that ends, reported through `subscribe`.
   */
  open(spec: AgentTerminalSpec): Promise<AgentTerminalSession>;
  /** The live session of one project, or `null` when that project has none open. */
  findByProject(projectId: ProjectId): AgentTerminalSession | null;
  /** One session by id, or `null` when it never existed or has been reaped. */
  find(sessionId: string): AgentTerminalSession | null;
  /** How many sessions are running right now, across every project. */
  liveCount(): number;
}
