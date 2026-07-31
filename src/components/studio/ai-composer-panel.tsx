"use client";

import * as React from "react";
import { CornerDownLeftIcon, TerminalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AGENT_COMMAND,
  AGENT_LABEL,
  terminalTranscript,
} from "@/lib/studio/agent-session";
import type { AgentId, TerminalLine } from "@/lib/studio/types";
import { TerminalView } from "./terminal-view";

const AGENTS: AgentId[] = ["claude", "codex"];

/**
 * The agent session that authors scenes. The transcript is scripted — no Codex
 * process or MCP server is attached — but "Generate scene" performs the real
 * write: the server inserts the scene into index.html through the HyperFrames
 * SDK and records its TTS job, so the Video Scene tab can edit it afterwards.
 */
export function AiComposerPanel({
  projectSlug,
  onProjectChanged,
}: {
  projectSlug: string;
  onProjectChanged: () => void;
}) {
  const [agent, setAgent] = React.useState<AgentId>("codex");
  const [prompt, setPrompt] = React.useState("");
  const [extra, setExtra] = React.useState<TerminalLine[]>([]);
  const [pending, setPending] = React.useState(false);

  const lines = [...terminalTranscript(agent, projectSlug), ...extra];

  const generate = async () => {
    const text = prompt.trim();
    if (!text || pending) return;

    setPending(true);
    setExtra((current) => [
      ...current,
      { kind: "output", text: "" },
      { kind: "output", text: `> ${text}` },
      { kind: "muted", text: "· mcp hyperframes.add_scene …" },
    ]);

    try {
      const response = await fetch(`/api/hf/${projectSlug}/scene`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate", prompt: text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        transcript?: TerminalLine[];
        error?: string;
      } | null;

      if (!response.ok) {
        setExtra((current) => [
          ...current,
          {
            kind: "output",
            text: `✗ ${payload?.error ?? `failed (${response.status})`}`,
          },
        ]);
        return;
      }

      setExtra((current) => [...current, ...(payload?.transcript ?? [])]);
      setPrompt("");
      onProjectChanged();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="bg-sidebar flex h-10 shrink-0 items-center gap-3 border-b px-3">
        <ToggleGroup
          type="single"
          size="sm"
          value={agent}
          onValueChange={(value) => value && setAgent(value as AgentId)}
        >
          {AGENTS.map((id) => (
            <ToggleGroupItem key={id} value={id} className="px-2.5 text-xs">
              {AGENT_LABEL[id]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium">
          mock MCP
        </span>

        <span className="text-muted-foreground ml-auto flex items-center gap-1.5 truncate font-mono text-[11px]">
          <TerminalIcon className="size-3.5 shrink-0" />
          {AGENT_COMMAND[agent]} · ~/projects/{projectSlug}
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1 bg-neutral-950">
        <TerminalView lines={lines} prompt=">" />
      </ScrollArea>

      <form
        className="bg-sidebar flex shrink-0 items-center gap-2 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
      >
        <Input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe a scene for the agent to add…"
          className="h-8 grow font-mono text-xs"
          disabled={pending}
        />
        <Button
          type="submit"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={pending || prompt.trim() === ""}
        >
          <CornerDownLeftIcon className="size-3" />
          {pending ? "Working…" : "Generate scene"}
        </Button>
      </form>
    </div>
  );
}
