import type { AgentId } from "./types";

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export const AGENT_COMMAND: Record<AgentId, string> = {
  claude: "claude",
  codex: "codex",
};
