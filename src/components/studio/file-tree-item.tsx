"use client";

import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/studio/types";
import { FileIcon } from "./file-icon";

export function FileTreeItem({
  node,
  depth = 0,
  selected,
  dirty = false,
  expanded,
  onSelect,
  onToggle,
}: {
  node: FileNode;
  depth?: number;
  selected: boolean;
  /** Has unsaved edits in the editor. */
  dirty?: boolean;
  expanded: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const isFolder = node.kind === "folder";
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <button
      type="button"
      onClick={() => (isFolder ? onToggle(node.path) : onSelect(node.path))}
      aria-expanded={isFolder ? expanded : undefined}
      data-selected={selected || undefined}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-xs",
        "text-muted-foreground hover:bg-muted hover:text-foreground",
        "data-selected:bg-accent data-selected:text-accent-foreground data-selected:font-medium",
      )}
      style={{ paddingLeft: `${depth * 12 + 6}px` }}
    >
      {isFolder ? (
        <Chevron className="size-3 shrink-0" />
      ) : (
        <span className="size-3 shrink-0" />
      )}
      <FileIcon node={node} />
      <span className="truncate">{node.name}</span>
      {dirty ? (
        <span
          aria-label="unsaved changes"
          className="bg-studio-accent ml-auto size-1.5 shrink-0 rounded-full"
        />
      ) : null}
    </button>
  );
}
