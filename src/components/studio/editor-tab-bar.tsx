"use client";

import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SourceFile } from "@/lib/studio/types";
import { FileIcon } from "./file-icon";

export function EditorTabBar({
  files,
  activePath,
  dirtyPaths,
  onActivate,
  onClose,
}: {
  files: SourceFile[];
  activePath: string;
  /** Tabs with unsaved edits — marked with a dot, the way an editor does. */
  dirtyPaths: string[];
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    <div className="bg-sidebar flex h-8 shrink-0 items-stretch overflow-x-auto border-b">
      {files.map((file) => {
        const name = file.path.split("/").pop() ?? file.path;
        const isActive = file.path === activePath;
        const isDirty = dirtyPaths.includes(file.path);
        return (
          <div
            key={file.path}
            data-active={isActive || undefined}
            className={cn(
              "group/tab flex shrink-0 items-center gap-1.5 border-r pr-1 pl-2.5 text-xs",
              "text-muted-foreground data-active:bg-background data-active:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onActivate(file.path)}
              title={file.path}
              className="flex items-center gap-1.5 py-1.5 whitespace-nowrap"
            >
              <FileIcon node={{ path: file.path, name, kind: "file" }} />
              {name}
            </button>
            <button
              type="button"
              onClick={() => onClose(file.path)}
              aria-label={
                isDirty ? `Close ${name} (unsaved changes)` : `Close ${name}`
              }
              className="hover:bg-muted rounded-sm p-0.5 group-hover/tab:opacity-100 data-active:opacity-100"
            >
              {/* The dot replaces the close icon until hover, exactly so an
                  unsaved tab is visible without opening it. */}
              {isDirty ? (
                <span className="block size-2 rounded-full bg-current group-hover/tab:hidden" />
              ) : null}
              <XIcon className={cn("size-3", isDirty && "hidden group-hover/tab:block")} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
