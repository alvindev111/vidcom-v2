"use client";

import * as React from "react";

import type { SceneScriptLine } from "@/lib/studio/types";

const AUTOSAVE_DELAY = 800;

export function SceneScriptEditor({
  script,
  pending,
  onSave,
}: {
  script: SceneScriptLine[];
  pending: boolean;
  onSave: (line: SceneScriptLine, text: string) => void;
}) {
  if (script.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No on-screen copy found in this scene.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2">
      {script.map((line, index) => (
        <ScriptLine
          key={line.id}
          line={line}
          index={index + 1}
          pending={pending}
          onSave={onSave}
        />
      ))}
    </ol>
  );
}

/**
 * One editable line. It autosaves once typing stops rather than on Enter, so a
 * long line can be reworked without every pause writing to disk — the same
 * "saves after you stop typing" behaviour the preview editor uses.
 */
function ScriptLine({
  line,
  index,
  pending,
  onSave,
}: {
  line: SceneScriptLine;
  index: number;
  pending: boolean;
  onSave: (line: SceneScriptLine, text: string) => void;
}) {
  const [draft, setDraft] = React.useState(line.text);
  const [dirty, setDirty] = React.useState(false);

  // Re-seed when the server sends a different value for this element.
  const [seeded, setSeeded] = React.useState(line.text);
  if (seeded !== line.text) {
    setSeeded(line.text);
    setDraft(line.text);
    setDirty(false);
  }

  // Held in a ref, not read from the closure: the parent re-renders on every
  // player tick and hands down a fresh `onSave`/`line`. With those in the
  // dependency list the timer below was cleared and restarted ~60 times a
  // second during playback, so the autosave never actually fired.
  const commit = React.useRef<() => void>(() => {});
  React.useEffect(() => {
    commit.current = () => {
      onSave(line, draft);
      setDirty(false);
    };
  });

  React.useEffect(() => {
    if (!dirty || draft === line.text) return;
    const timer = setTimeout(() => commit.current(), AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [dirty, draft, line.text]);

  return (
    <li className="flex gap-2">
      <span className="text-muted-foreground w-5 shrink-0 pt-2 font-mono text-[10px]">
        {String(index).padStart(2, "0")}
      </span>

      <div className="flex min-w-0 grow flex-col gap-1">
        <textarea
          value={draft}
          rows={2}
          title={`${line.file} · ${line.id}`}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
          }}
          onBlur={() => {
            if (!dirty || draft === line.text) return;
            onSave(line, draft);
            setDirty(false);
          }}
          className="border-input bg-background focus-visible:ring-ring/50 field-sizing-content min-h-14 w-full resize-none rounded-md border px-2 py-1.5 text-xs leading-relaxed focus-visible:ring-3 focus-visible:outline-hidden"
        />
        <span className="text-muted-foreground text-[10px]">
          {dirty ? "Saves after you stop typing…" : pending ? "Saving…" : "Saved"}
        </span>
      </div>
    </li>
  );
}
