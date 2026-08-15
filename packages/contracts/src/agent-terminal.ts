import { z } from "zod";

import { IdentifierSchema } from "./dto";

/**
 * The agent CLIs the composer is allowed to launch.
 *
 * A closed enum rather than a free string, because this value becomes `argv[0]`
 * of a spawned process. Anything open here would let a request name the
 * executable, which is the whole of [09-security](../../../llm-documents/steering/09-security.md) §8 undone in one field.
 */
export const AgentIdSchema = z.enum(["claude", "codex"]);
export type AgentId = z.infer<typeof AgentIdSchema>;

/**
 * 1000 — a terminal wider or taller than this is a bug in the client's measure,
 * not a window somebody opened. ConPTY allocates a screen buffer per dimension,
 * so an unbounded value is a memory request the daemon would honour.
 */
const MAX_TERMINAL_DIMENSION = 1000;

const TerminalSizeShape = {
  cols: z.number().int().min(1).max(MAX_TERMINAL_DIMENSION),
  rows: z.number().int().min(1).max(MAX_TERMINAL_DIMENSION),
};

/** Strict path parameters for one open terminal session. */
export const AgentTerminalParamsSchema = z.strictObject({
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
});

/** Opens (or re-attaches to) the agent terminal of one project. */
export const StartAgentTerminalRequestSchema = z.strictObject({
  agent: AgentIdSchema,
  ...TerminalSizeShape,
});

/**
 * 8 KiB — one paste, not a file.
 *
 * Keystrokes arrive one or two bytes at a time; the ceiling exists for the paste
 * path, where a client can hand over a whole clipboard in a single frame. Larger
 * than that is a file transfer wearing a terminal's clothes.
 */
export const MAX_TERMINAL_INPUT_BYTES = 8 * 1024;

/** Keystrokes or pasted text written to the agent's stdin. */
export const AgentTerminalInputRequestSchema = z.strictObject({
  data: z.string().min(1).max(MAX_TERMINAL_INPUT_BYTES),
});

/** A new viewport size for an already-open session. */
export const AgentTerminalResizeRequestSchema = z.strictObject(TerminalSizeShape);

/** What the client needs to attach its terminal emulator to a started session. */
export interface StartAgentTerminalResponse {
  sessionId: string;
  agent: AgentId;
  /**
   * The MCP server name the agent was launched with, so the UI can say which
   * server the session is talking to rather than asserting one that may have
   * been renamed.
   */
  mcpServerName: string;
  /** Whether this call attached to a session that was already running. */
  reattached: boolean;
}

/**
 * One frame of the terminal SSE stream.
 *
 * `data` carries raw PTY bytes including ANSI control sequences — the client
 * MUST hand them to a terminal emulator rather than rendering them as text.
 * `exit` is terminal: no further frame follows it on that stream.
 */
export type AgentTerminalFrame =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number | null };
