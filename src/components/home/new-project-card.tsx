import { PlusIcon } from "lucide-react";

/**
 * Creating a project means running `hyperframes init` on the server, which is
 * not wired yet — the card is rendered as a disabled button rather than a link
 * to a route that cannot do anything.
 */
export function NewProjectCard() {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-dashed">
      <button
        type="button"
        disabled
        className="hover:bg-muted/40 flex aspect-video flex-col items-center justify-center gap-2 disabled:cursor-not-allowed"
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
    </div>
  );
}
