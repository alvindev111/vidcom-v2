"use client";

import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SourceFile } from "@/lib/studio/types";
import { FileIcon } from "./file-icon";

export function EditorTabBar({
  files,
  activePath,
  onActivate,
  onClose,
}: {
  files: SourceFile[];
  activePath: string;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
}) {
  return (
    <div className="bg-sidebar flex h-8 items-stretch border-b">
      {files.map((file) => {
        const name = file.path.split("/").pop() ?? file.path;
        const isActive = file.path === activePath;
        return (
          <div
            key={file.path}
            data-active={isActive || undefined}
            className={cn(
              "group/tab flex items-center gap-1.5 border-r pr-1 pl-2.5 text-xs",
              "text-muted-foreground data-active:bg-background data-active:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onActivate(file.path)}
              className="flex items-center gap-1.5 py-1.5"
            >
              <FileIcon node={{ path: file.path, name, kind: "file" }} />
              {name}
            </button>
            <button
              type="button"
              onClick={() => onClose(file.path)}
              aria-label={`Close ${name}`}
              className="hover:bg-muted rounded-sm p-0.5 opacity-0 group-hover/tab:opacity-100 data-active:opacity-100"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
