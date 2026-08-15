import { ErrorCode, type AgentId, type DomainError, type ProjectId } from "@vidcom/contracts";

import type { AbsolutePath } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { AgentKitHost, AgentKitInstaller } from "./agent-kit-install";
import type {
  AgentTerminalPort,
  AgentTerminalSession,
  McpServerDescriptor,
} from "../port/agent-terminal-port";
import type { WorkspacePort } from "../port/ports";

/**
 * 4 — one terminal per project the user can plausibly have open at once.
 *
 * A ceiling rather than none: every session is an agent CLI plus the model
 * process behind it, and [09-security](../../../../llm-documents/steering/09-security.md) §8 requires a concurrent-process limit on
 * anything spawned from a request.
 */
export const MAX_AGENT_TERMINALS = 4;

export interface StartAgentTerminalInput {
  projectId: ProjectId;
  agent: AgentId;
  cols: number;
  rows: number;
}

export interface StartAgentTerminalOutput {
  session: AgentTerminalSession;
  /** Whether an already-running session was returned instead of a new one. */
  reattached: boolean;
}

export interface StartAgentTerminalDependencies {
  workspace: Pick<WorkspacePort, "readProjectRef">;
  terminals: AgentTerminalPort;
  /** Where the agent should find VidCom's own tools; the composition root knows how to call this build. */
  mcpServer: McpServerDescriptor;
  workspaceRoot: AbsolutePath;
  agentKit: Pick<AgentKitInstaller, "apply">;
}

/** Both CLIs read their instructions from a file named for them, so the kit is installed per host. */
function agentKitHost(agent: AgentId): AgentKitHost {
  return agent === "codex" ? "codex" : "claude-code";
}

/**
 * Opens the agent terminal of one project, or re-attaches to the one already
 * running there.
 *
 * Requires the project to exist; the agent is launched with that project's
 * directory as its working root, so it can only reach files the user is
 * currently editing. Writes nothing itself — every change the agent makes goes
 * through the MCP server named in `mcpServer`, which is the same tool surface
 * and the same audit trail an external AI host gets.
 *
 * Re-attaching rather than starting a second CLI is deliberate: the browser
 * re-mounts the pane on every tab switch, and a fresh agent per mount would
 * leave orphaned models running and lose the conversation the user was having.
 * Emits no domain event — a terminal session is not a project revision.
 */
export async function startAgentTerminal(
  dependencies: StartAgentTerminalDependencies,
  input: StartAgentTerminalInput,
): Promise<Result<StartAgentTerminalOutput, DomainError>> {
  const existing = dependencies.terminals.findByProject(input.projectId);
  if (existing) {
    // Resized on re-attach, not left alone: the pane that re-mounted may be a
    // different width, and a TUI told nothing keeps drawing at the old size.
    existing.resize(input.cols, input.rows);
    return ok({ session: existing, reattached: true });
  }

  if (dependencies.terminals.liveCount() >= MAX_AGENT_TERMINALS) {
    return err({
      code: ErrorCode.AgentSessionLimit,
      message: `${MAX_AGENT_TERMINALS} agent terminals are already running — close one before opening another`,
    });
  }

  const ref = await dependencies.workspace.readProjectRef(input.projectId);
  if (!ref) {
    return err({
      code: ErrorCode.ProjectNotFound,
      message: "project does not exist",
      field: "id",
    });
  }

  // Before the spawn, never after: both CLIs read their instruction file off
  // disk while they boot, so a kit written a moment later is one the running
  // session never sees. Without it the agent has no idea VidCom's tools exist —
  // it asked the user to choose a video format for a project that already
  // declares one, instead of calling `get_project_context`.
  const kit = await dependencies.agentKit.apply(
    dependencies.workspaceRoot,
    { hosts: [agentKitHost(input.agent)] },
  );
  if (!kit.ok) {
    // Not fatal, and deliberately so: an agent without its kit is less oriented
    // but still usable, and refusing to open a terminal because a markdown file
    // could not be written would trade a whole capability for a hint.
  }

  try {
    const session = await dependencies.terminals.open({
      projectId: input.projectId,
      agent: input.agent,
      cwd: ref.root,
      cols: input.cols,
      rows: input.rows,
      mcpServer: dependencies.mcpServer,
    });
    return ok({ session, reattached: false });
  } catch (cause) {
    return err({
      code: ErrorCode.AgentUnavailable,
      message: `${input.agent} could not be started — check that it is installed and on PATH`,
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}
