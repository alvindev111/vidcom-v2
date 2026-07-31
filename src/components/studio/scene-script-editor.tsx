"use client";

import * as React from "react";
import { CheckIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SceneScriptLine } from "@/lib/studio/types";

export function SceneScriptEditor({
  script,
  pending,
  onSave,
}: {
  script: SceneScriptLine[];
  pending: boolean;
  onSave: (line: SceneScriptLine, text: string) => void;
}) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");

  if (script.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        No on-screen copy found in this scene.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-1.5">
      {script.map((line, index) => {
        const isEditing = editingId === line.id;

        return (
          <li key={line.id} className="flex items-center gap-2">
            <span className="text-muted-foreground w-5 shrink-0 font-mono text-[10px]">
              {String(index + 1).padStart(2, "0")}
            </span>

            {isEditing ? (
              <>
                <Input
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setEditingId(null);
                    if (event.key === "Enter") {
                      onSave(line, draft);
                      setEditingId(null);
                    }
                  }}
                  className="h-7 grow text-xs"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  aria-label="Save line"
                  disabled={pending}
                  onClick={() => {
                    onSave(line, draft);
                    setEditingId(null);
                  }}
                >
                  <CheckIcon className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  aria-label="Cancel"
                  onClick={() => setEditingId(null)}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditingId(line.id);
                  setDraft(line.text);
                }}
                className="hover:bg-muted min-w-0 grow rounded-sm px-1.5 py-1 text-left text-xs"
                title={`${line.file} · ${line.id}`}
              >
                {line.text}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
