import { RotateCcwIcon, SaveIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function EditorFooter({
  path,
  dirty,
  saving,
  error,
  saveBlocked = false,
  onSave,
  onRevert,
}: {
  path: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** Something changed under this draft; saving would overwrite it unread. */
  saveBlocked?: boolean;
  onSave: () => void;
  onRevert: () => void;
}) {
  return (
    <div className="bg-sidebar shrink-0 border-t">
      {error ? (
        <p
          className="text-destructive border-b px-3 py-1.5 text-[11px]"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="text-muted-foreground flex h-6 items-center justify-between px-3 font-mono text-[11px]">
        <span className="truncate">{path}</span>
        <span className={dirty ? "text-studio-accent" : undefined}>
          {saving ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}
        </span>
      </div>

      {/* Save is only offered when there is something to save — the agent writes
          these files most of the time, so a permanently armed button would read
          as if a manual save were expected. */}
      {dirty ? (
        <div className="flex h-8 items-center justify-end gap-1 border-t px-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1.5 text-xs"
            disabled={saving}
            onClick={onRevert}
          >
            <RotateCcwIcon className="size-3.5" />
            Revert
          </Button>
          <Button
            size="sm"
            className="h-6 gap-1.5 text-xs"
            disabled={saving || saveBlocked}
            onClick={onSave}
          >
            <SaveIcon className="size-3.5" />
            {saving ? "Saving…" : "Save"}
            <span className="opacity-60">⌘S</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
