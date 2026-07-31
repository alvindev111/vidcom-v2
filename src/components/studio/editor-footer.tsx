import { ClipboardCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function EditorFooter({
  path,
  saved,
}: {
  path: string;
  saved: boolean;
}) {
  return (
    <div className="bg-sidebar shrink-0 border-t">
      <div className="text-muted-foreground flex h-6 items-center justify-between px-3 font-mono text-[11px]">
        <span className="truncate">{path}</span>
        <span>{saved ? "Saved" : "Unsaved"}</span>
      </div>
      <div className="flex h-8 items-center justify-center border-t">
        <Button variant="ghost" size="sm" className="h-6 gap-1.5 text-xs">
          <ClipboardCheckIcon className="size-3.5" />
          Lint
        </Button>
      </div>
    </div>
  );
}
