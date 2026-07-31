import type { AgentId, TerminalLine } from "./types";

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export const AGENT_COMMAND: Record<AgentId, string> = {
  claude: "claude",
  codex: "codex",
};

/**
 * Canned session for the AI Composer pane. Running a real agent needs a PTY on
 * the server; until that exists this shows the shape of the session.
 */
export function terminalTranscript(
  agent: AgentId,
  project: string,
): TerminalLine[] {
  const header: TerminalLine[] = [
    { kind: "muted", text: `~/projects/${project}` },
    { kind: "command", text: AGENT_COMMAND[agent] },
  ];

  if (agent === "codex") {
    return [
      ...header,
      { kind: "accent", text: `● Codex CLI — workspace ${project}` },
      { kind: "output", text: "" },
      { kind: "output", text: "> tighten the headline tracking on scene-01" },
      { kind: "output", text: "" },
      { kind: "muted", text: "· patch index.html" },
      { kind: "output", text: "" },
      { kind: "output", text: "letter-spacing: -0.02em → -0.035em on .headline." },
    ];
  }

  return [
    ...header,
    { kind: "accent", text: `● Claude Code v2.1.0 — composing in ${project}` },
    { kind: "output", text: "" },
    {
      kind: "output",
      text: "> add a logo cascade after the headline, staggered 80ms",
    },
    { kind: "output", text: "" },
    { kind: "muted", text: "· Read index.html (78 lines)" },
    { kind: "muted", text: "· Edit index.html — +34 −2" },
    { kind: "muted", text: "· Bash hyperframes lint" },
    { kind: "accent", text: "✓ lint: 0 errors, 0 warnings" },
    { kind: "output", text: "" },
    {
      kind: "output",
      text: "Added a .logo-grid scene with a GSAP stagger of 0.08s and",
    },
    { kind: "output", text: "registered it on the main timeline at 3.4s." },
  ];
}
