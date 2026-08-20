"use client";

import * as React from "react";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";

import { callService } from "@/lib/api/services";
import type { PresetId } from "@/lib/new-project/state";

import { NewProjectDialog } from "./new-project-dialog";

/**
 * Opens the deliberately small create-project form; generation remains an MCP
 * agent workflow rather than a promise hidden behind this button.
 */
export function NewProjectCard() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const create = React.useCallback((input: { name: string; presetId: PresetId }) =>
    callService<{ slug: string }>("v1.projects.create", { body: input }), []);

  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-dashed">
      <button
        type="button"
        onClick={() => { setOpen(true); }}
        className="hover:bg-muted/40 flex aspect-video flex-col items-center justify-center gap-2"
      >
        <span className="border-studio-accent/60 text-studio-accent grid size-9 place-items-center rounded-full border">
          <PlusIcon className="size-4" />
        </span>
        <span className="text-studio-accent text-sm">New video</span>
      </button>

      {/*
        The card creates an empty project; generation happens through an agent
        connected over MCP, which is a separate thing the user sets up. Promising
        it here made the button look like it would write the video.
      */}
      <span className="text-muted-foreground border-t px-3 py-2.5 text-xs">
        Or ask a connected AI agent to build one
      </span>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Create a new video"
          className="bg-background absolute inset-0 z-10 overflow-auto"
        >
          <button
            type="button"
            className="float-right px-3 py-2 text-sm underline"
            onClick={() => { setOpen(false); }}
          >
            Close
          </button>
          <NewProjectDialog
            api={{ create }}
            onCreated={(slug) => { router.push(`/projects/${encodeURIComponent(slug)}`); }}
          />
        </div>
      ) : null}
    </div>
  );
}
