"use client";

import * as React from "react";
import { CornerDownLeftIcon, RotateCcwIcon, SparklesIcon, SquareIcon, TerminalIcon } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fetchApi } from "@/lib/api/services";
import { AGENT_COMMAND, AGENT_LABEL } from "@/lib/studio/agent-session";
import {
  resizeAgentTerminal,
  startAgentTerminal,
  stopAgentTerminal,
  streamAgentTerminal,
  submitAgentTerminalLine,
  writeAgentTerminal,
  type StartedAgentTerminal,
} from "@/lib/studio/agent-terminal-client";
import type { AgentId, TerminalLine } from "@/lib/studio/types";

const AGENTS: AgentId[] = ["claude", "codex"];

/** Matches the pane's dark surface so the emulator does not sit on its own colour. */
const TERMINAL_THEME = { background: "#0a0a0a", foreground: "#e5e5e5", cursor: "#e5e5e5" };

/**
 * A real agent CLI, running under a pseudo-terminal in the project directory
 * with VidCom's MCP server already wired in.
 *
 * The pane used to render a scripted transcript. It now attaches xterm.js to a
 * session the daemon opened with node-pty, so the agent's own full-screen UI is
 * what appears — and the tools it calls are the same 18 the MCP server exposes
 * to any external host.
 *
 * The session outlives this component on purpose: unmounting closes the stream
 * but leaves the agent running, so switching to the Code tab and back returns to
 * the same conversation rather than starting a second CLI.
 */
export function AiComposerPanel({
  projectId,
  projectSlug,
  onProjectChanged,
}: {
  projectId: string;
  projectSlug: string;
  onProjectChanged: () => void;
}) {
  const [agent, setAgent] = React.useState<AgentId>("codex");
  const [prompt, setPrompt] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [session, setSession] = React.useState<StartedAgentTerminal | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [exited, setExited] = React.useState(false);
  const [restarts, setRestarts] = React.useState(0);

  const host = React.useRef<HTMLDivElement>(null);
  const terminal = React.useRef<{ write(data: string): void } | null>(null);
  // Read at attach time rather than from the effect's closure: the toggle must
  // not tear down a running agent, so `agent` is deliberately not a dependency.
  const requested = React.useRef<AgentId>(agent);
  React.useEffect(() => { requested.current = agent; }, [agent]);

  React.useEffect(() => {
    const container = host.current;
    if (!container) return;

    let cancelled = false;
    let teardown = () => {};

    void (async () => {
      // Imported here, not at module scope: xterm touches `document` while it
      // initialises, and this page is prerendered into a static export.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled) return;

      const term = new Terminal({
        fontSize: 12,
        fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
        theme: TERMINAL_THEME,
        cursorBlink: true,
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      fit.fit();
      terminal.current = term;

      let started: StartedAgentTerminal;
      try {
        started = await startAgentTerminal({
          projectId,
          agent: requested.current,
          cols: term.cols,
          rows: term.rows,
        });
      } catch (error) {
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : String(error));
          term.dispose();
          terminal.current = null;
        }
        return;
      }
      if (cancelled) {
        term.dispose();
        return;
      }

      setFailure(null);
      setExited(false);
      setSession(started);

      const closeStream = streamAgentTerminal(projectId, started.sessionId, (frame) => {
        if (frame.type === "data") term.write(frame.data);
        else {
          setExited(true);
          term.write(`\r\n\x1b[90m— ${requested.current} exited (${frame.exitCode ?? "signal"}) —\x1b[0m\r\n`);
        }
      });
      const typed = term.onData((data) => writeAgentTerminal(projectId, started.sessionId, data));
      const resized = term.onResize(({ cols, rows }) =>
        resizeAgentTerminal(projectId, started.sessionId, cols, rows));
      const observer = new ResizeObserver(() => {
        // Guarded: `fit` measures the container, and a pane hidden behind
        // another tab measures zero, which throws inside the addon.
        try { fit.fit(); } catch { /* hidden pane; the next visible resize fits */ }
      });
      observer.observe(container);

      teardown = () => {
        closeStream();
        typed.dispose();
        resized.dispose();
        observer.disconnect();
        term.dispose();
        terminal.current = null;
      };
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [projectId, restarts]);

  const restart = async () => {
    if (session) await stopAgentTerminal(projectId, session.sessionId);
    setSession(null);
    setRestarts((count) => count + 1);
  };

  /**
   * Hands one composed line to the agent and submits it.
   *
   * This row exists because typing straight into xterm loses Vietnamese
   * diacritics. IMEs like UniKey and EVKey do not emit composition events — they
   * send a backspace and re-send the replaced character — and xterm resets its
   * hidden textarea after every keystroke, so the character the IME means to
   * replace is gone before it can. A real `<input>` keeps its own value, so the
   * IME behaves exactly as it does everywhere else and the terminal receives the
   * finished text.
   *
   * The prompt is cleared before the write settles: the text is already on its
   * way, and leaving it in the box until the round trip finishes reads as the
   * button having missed the click.
   */
  const send = () => {
    const text = prompt.trim();
    if (!text || !session || exited) return;
    setPrompt("");
    void submitAgentTerminalLine(projectId, session.sessionId, text);
  };

  const generate = async () => {
    const text = prompt.trim();
    if (!text || pending) return;

    setPending(true);
    try {
      const response = await fetchApi(`/api/hf/${projectSlug}/scene`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "generate", prompt: text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        transcript?: TerminalLine[];
        error?: string;
      } | null;

      if (!response.ok) {
        terminal.current?.write(`\r\n\x1b[31m✗ ${payload?.error ?? `failed (${response.status})`}\x1b[0m\r\n`);
        return;
      }
      for (const line of payload?.transcript ?? []) {
        terminal.current?.write(`\x1b[90m${line.text}\x1b[0m\r\n`);
      }
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

        {session && !exited ? (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
            mcp {session.mcpServerName}
          </span>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => void restart()}
        >
          {exited || !session
            ? <><RotateCcwIcon className="size-3" />Start</>
            : <><SquareIcon className="size-3" />Stop</>}
        </Button>

        <span className="text-muted-foreground ml-auto flex items-center gap-1.5 truncate font-mono text-[11px]">
          <TerminalIcon className="size-3.5 shrink-0" />
          {AGENT_COMMAND[session?.agent ?? agent]} · {projectSlug}
        </span>
      </div>

      {failure ? (
        <p className="border-b bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-500">
          {failure}
        </p>
      ) : null}

      <div ref={host} className="min-h-0 flex-1 overflow-hidden bg-neutral-950 p-2" />

      <form
        className="bg-sidebar flex shrink-0 items-center gap-2 border-t p-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Input
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Type here for Vietnamese and other IME input — Enter sends it to the agent"
          className="h-8 grow font-mono text-xs"
          disabled={pending}
        />
        <Button
          type="submit"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={pending || prompt.trim() === "" || !session || exited}
        >
          <CornerDownLeftIcon className="size-3" />
          Send
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void generate()}
          disabled={pending || prompt.trim() === ""}
        >
          <SparklesIcon className="size-3" />
          {pending ? "Working…" : "Generate scene"}
        </Button>
      </form>
    </div>
  );
}
