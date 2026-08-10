import { resolveApiBaseUrl } from "@/lib/api/base-url";
import type { AgentId } from "./types";

/** What the daemon reports after opening — or re-attaching to — a session. */
export interface StartedAgentTerminal {
  sessionId: string;
  agent: AgentId;
  mcpServerName: string;
  reattached: boolean;
}

/** One frame off the terminal stream; `exit` is the last frame on that stream. */
export type AgentTerminalFrame =
  | { type: "data"; data: string }
  | { type: "exit"; exitCode: number | null };

function sessionRoot(projectId: string, sessionId: string): string {
  return `${resolveApiBaseUrl()}/api/v1/projects/${encodeURIComponent(projectId)}`
    + `/agent-terminal/${encodeURIComponent(sessionId)}`;
}

async function send(url: string, method: "POST" | "DELETE", body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

/**
 * Opens the project's agent terminal, or re-attaches to the one already running.
 *
 * Rejects with the daemon's own message when the agent CLI is missing or the
 * concurrent-session ceiling is reached — both are things the user can act on,
 * so neither is flattened into "could not start".
 */
export async function startAgentTerminal(input: {
  projectId: string;
  agent: AgentId;
  cols: number;
  rows: number;
}): Promise<StartedAgentTerminal> {
  const response = await send(
    `${resolveApiBaseUrl()}/api/v1/projects/${encodeURIComponent(input.projectId)}/agent-terminal`,
    "POST",
    { agent: input.agent, cols: input.cols, rows: input.rows },
  );
  const payload = await response.json().catch(() => null) as
    | StartedAgentTerminal
    | { error?: { message?: string } }
    | null;
  if (!response.ok) {
    const message = payload && "error" in payload ? payload.error?.message : undefined;
    throw new Error(message ?? `the agent terminal could not be started (${response.status})`);
  }
  return payload as StartedAgentTerminal;
}

/**
 * Streams the session's output, replaying everything printed before this call.
 *
 * `EventSource` rather than `fetch` streaming: it reconnects on its own and
 * sends the session cookie, and the replay on the server side makes a
 * reconnection harmless. Returns the close function.
 */
export function streamAgentTerminal(
  projectId: string,
  sessionId: string,
  onFrame: (frame: AgentTerminalFrame) => void,
): () => void {
  const source = new EventSource(`${sessionRoot(projectId, sessionId)}/stream`);
  const handle = (event: MessageEvent<string>) => {
    // A frame that will not parse is dropped rather than thrown: the stream is
    // the terminal, and killing it over one malformed line loses the session.
    try { onFrame(JSON.parse(event.data) as AgentTerminalFrame); }
    catch { return; }
  };
  source.addEventListener("data", handle);
  source.addEventListener("exit", (event) => {
    handle(event as MessageEvent<string>);
    source.close();
  });
  return () => source.close();
}

/** Sends keystrokes or pasted text to the agent's stdin. */
export function writeAgentTerminal(projectId: string, sessionId: string, data: string): Promise<Response> {
  return send(`${sessionRoot(projectId, sessionId)}/input`, "POST", { data });
}

/** Wraps text the way a terminal marks a paste, so a TUI knows where it ends. */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * Sends one composed line and then submits it.
 *
 * Two writes, and the order is the whole point. Sending `text\r` as a single
 * write put the line into the agent's prompt without running it: Codex and
 * Claude Code both turn on bracketed paste, and a newline arriving inside a
 * paste is inserted as a line break rather than treated as Enter — which is
 * correct behaviour for pasting a paragraph, and exactly wrong here. Marking the
 * text as a paste and sending the carriage return afterwards makes the agent
 * read it as a keypress.
 *
 * The second write is awaited rather than fired alongside the first, because two
 * concurrent requests can reach the daemon out of order and an Enter that
 * arrives first submits an empty prompt.
 */
export async function submitAgentTerminalLine(
  projectId: string,
  sessionId: string,
  text: string,
): Promise<void> {
  await writeAgentTerminal(projectId, sessionId, `${PASTE_START}${text}${PASTE_END}`);
  await writeAgentTerminal(projectId, sessionId, "\r");
}

/** Tells the agent its viewport changed so full-screen UIs redraw at the new size. */
export function resizeAgentTerminal(
  projectId: string,
  sessionId: string,
  cols: number,
  rows: number,
): void {
  void send(`${sessionRoot(projectId, sessionId)}/resize`, "POST", { cols, rows });
}

/** Kills the agent; the pane can then start a different one. */
export async function stopAgentTerminal(projectId: string, sessionId: string): Promise<void> {
  await send(sessionRoot(projectId, sessionId), "DELETE");
}
