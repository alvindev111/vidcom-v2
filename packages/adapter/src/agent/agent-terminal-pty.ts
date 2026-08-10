import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";

import type { AgentTerminalFrame, ProjectId } from "@vidcom/contracts";
import type {
  AgentTerminalPort,
  AgentTerminalSession,
  AgentTerminalSpec,
} from "@vidcom/core";
import { spawn, type IPty } from "node-pty";

import { agentInvocation } from "./agent-cli-invocation";
import { consoleLaunchPlan, resolveExecutable } from "./executable-lookup";

/**
 * 256 KiB of replay — enough for an agent's banner and the last few exchanges.
 *
 * Replay exists because the browser attaches over a second request, so anything
 * printed between the POST that opened the session and the GET that reads it
 * would otherwise be gone. It is capped because a session left running for an
 * hour would otherwise hold every byte it ever printed.
 */
const MAX_REPLAY_BYTES = 256 * 1024;

/**
 * 5 minutes with nobody attached, then the agent is killed.
 *
 * A closed browser tab must not leave a model process running: nothing will
 * ever read its output again. Five minutes rather than seconds because
 * switching tabs in the studio detaches the stream, and a user who comes back
 * expects the session they left.
 */
const ORPHAN_GRACE_MS = 5 * 60 * 1000;

/** 60 seconds to collect the exit frame before an ended session is forgotten. */
const EXITED_RETENTION_MS = 60 * 1000;

/**
 * The environment an agent CLI is handed.
 *
 * The full parent environment, minus everything `VIDCOM_`-prefixed. This is a
 * deliberate departure from the sidecar rule in `ProcessPort`, which allowlists:
 * the agent is the *user's own* tool, and it needs their PATH to find its
 * runtime and their home to find its login. What it must never inherit is
 * VidCom's internal wiring — `VIDCOM_BOOTSTRAP_NONCE` is a session credential,
 * and a process listing is not where it belongs.
 */
function agentEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !entry[0].startsWith("VIDCOM_"),
    ),
  );
}

class PtySession implements AgentTerminalSession {
  private readonly listeners = new Set<(frame: AgentTerminalFrame) => void>();
  private replay = "";
  private exit: AgentTerminalFrame | null = null;
  private orphanTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly id: string,
    readonly projectId: ProjectId,
    readonly agent: AgentTerminalSpec["agent"],
    private readonly pty: IPty,
    private readonly onEnd: (session: PtySession) => void,
  ) {
    this.pty.onData((data) => this.emit({ type: "data", data }));
    this.pty.onExit(({ exitCode }) => {
      this.exit = { type: "exit", exitCode };
      for (const listener of this.listeners) listener(this.exit);
      this.listeners.clear();
      this.clearOrphanTimer();
      this.onEnd(this);
    });
    // Armed from the start: a session nobody ever attaches to is exactly the
    // case this protects against, and waiting for a first subscriber to arm it
    // would leave that one running forever.
    this.armOrphanTimer();
  }

  get ended(): boolean {
    return this.exit !== null;
  }

  write(data: string): void {
    if (this.ended) return;
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ended) return;
    // Guarded: resizing a pty whose child has gone throws on Windows, and this
    // is reached from a request that raced the agent exiting.
    try { this.pty.resize(cols, rows); }
    catch { /* the child is gone; the exit frame is already on its way */ }
  }

  close(): void {
    if (this.ended) return;
    try { this.pty.kill(); }
    catch { /* already reaped by the OS; onExit still settles the session */ }
  }

  subscribe(listener: (frame: AgentTerminalFrame) => void): () => void {
    if (this.replay.length > 0) listener({ type: "data", data: this.replay });
    if (this.exit) {
      listener(this.exit);
      return () => {};
    }
    this.listeners.add(listener);
    this.clearOrphanTimer();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.armOrphanTimer();
    };
  }

  private emit(frame: AgentTerminalFrame): void {
    if (frame.type === "data") {
      this.replay = (this.replay + frame.data).slice(-MAX_REPLAY_BYTES);
    }
    for (const listener of this.listeners) listener(frame);
  }

  private armOrphanTimer(): void {
    this.clearOrphanTimer();
    this.orphanTimer = setTimeout(() => this.close(), ORPHAN_GRACE_MS);
    // Unref'd so an idle terminal cannot hold the daemon open at shutdown.
    this.orphanTimer.unref?.();
  }

  private clearOrphanTimer(): void {
    if (this.orphanTimer) clearTimeout(this.orphanTimer);
    this.orphanTimer = undefined;
  }
}

/** Runs agent CLIs under a real pseudo-terminal, so their full-screen UIs work. */
export class NodePtyAgentTerminals implements AgentTerminalPort {
  private readonly sessions = new Map<string, PtySession>();

  private readonly environment: NodeJS.ProcessEnv;
  private readonly invocationFor: typeof agentInvocation;

  constructor(
    /** Owns generated MCP config files; MUST be inside app-data, never the workspace. */
    private readonly configDirectory: string,
    options: {
      environment?: NodeJS.ProcessEnv;
      /**
       * Seam for tests, so the pty plumbing can be exercised against a command
       * that exits on its own. Driving it with the real invocation would launch
       * an interactive agent that never returns, and skipping the real pty
       * would leave the one thing this class exists for untested.
       */
      invocationFor?: typeof agentInvocation;
    } = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.invocationFor = options.invocationFor ?? agentInvocation;
  }

  /**
   * Starts one agent CLI in `spec.cwd` under a pty sized to the client's
   * viewport.
   *
   * Writes a config file for the CLIs that need one (Claude Code) into
   * `configDirectory` and removes it once the session ends. Rejects when the
   * executable cannot be started at all — a `claude` that is not installed
   * throws here rather than producing a session that dies a moment later with an
   * empty screen.
   */
  async open(spec: AgentTerminalSpec): Promise<AgentTerminalSession> {
    const id = `terminal_${randomUUID()}`;
    const invocation = this.invocationFor({
      agent: spec.agent,
      mcpServer: spec.mcpServer,
      configDirectory: this.configDirectory,
      sessionId: id,
    });

    // Resolved before anything is written: a missing CLI is the common failure,
    // and reporting it by name beats leaving a config file behind for a session
    // that was never going to start.
    const executable = resolveExecutable(invocation.command, this.environment);
    if (executable === null) {
      throw new Error(`${invocation.command} is not installed or not on PATH`);
    }

    if (invocation.configFile) {
      await mkdir(this.configDirectory, { recursive: true });
      await writeFile(invocation.configFile.path, invocation.configFile.contents, "utf8");
    }

    const plan = consoleLaunchPlan(executable, invocation.args, this.environment);
    let pty: IPty;
    try {
      pty = spawn(plan.command, plan.args, {
        name: "xterm-256color",
        cols: spec.cols,
        rows: spec.rows,
        cwd: spec.cwd,
        // Layered after the filter, never before: the bearer's variable is
        // itself `VIDCOM_`-prefixed, so filtering last would strip the one value
        // the agent is being started to receive.
        env: { ...agentEnvironment(this.environment), ...invocation.environment },
      });
    } catch (cause) {
      if (invocation.configFile) await rm(invocation.configFile.path, { force: true });
      throw cause;
    }

    const session = new PtySession(id, spec.projectId, spec.agent, pty, (ended) => {
      if (invocation.configFile) {
        void rm(invocation.configFile.path, { force: true }).catch(() => {
          // The file carries no secret and lives in app-data; a failed cleanup
          // is not worth taking down the exit path that reports the session.
        });
      }
      const forget = setTimeout(() => {
        if (this.sessions.get(ended.id) === ended) this.sessions.delete(ended.id);
      }, EXITED_RETENTION_MS);
      forget.unref?.();
    });
    this.sessions.set(id, session);
    return session;
  }

  findByProject(projectId: ProjectId): AgentTerminalSession | null {
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && !session.ended) return session;
    }
    return null;
  }

  find(sessionId: string): AgentTerminalSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  liveCount(): number {
    let live = 0;
    for (const session of this.sessions.values()) if (!session.ended) live += 1;
    return live;
  }

  /** Kills every running agent; called when the daemon stops so no model outlives it. */
  closeAll(): void {
    for (const session of this.sessions.values()) session.close();
  }
}
