"use client";

import * as React from "react";
import { FilePlusIcon, FolderPlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FileNode } from "@/lib/studio/types";
import { FileTreeItem } from "./file-tree-item";

export function FileExplorer({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: FileNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = React.useState<string[]>([]);

  const toggle = (path: string) =>
    setExpanded((current) =>
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path],
    );

  const renderNodes = (nodes: FileNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      const isExpanded = expanded.includes(node.path);
      return (
        <React.Fragment key={node.path}>
          <FileTreeItem
            node={node}
            depth={depth}
            selected={node.path === selectedPath}
            expanded={isExpanded}
            onSelect={onSelect}
            onToggle={toggle}
          />
          {node.kind === "folder" && isExpanded
            ? node.children?.length
              ? renderNodes(node.children, depth + 1)
              : renderEmpty(depth + 1)
            : null}
        </React.Fragment>
      );
    });

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-8 items-center gap-1 border-b pr-1 pl-2">
        <span className="text-muted-foreground grow text-[11px] font-medium tracking-widest uppercase">
          Files
        </span>
        <Button variant="ghost" size="icon" className="size-6" aria-label="New file">
          <FilePlusIcon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="New folder"
        >
          <FolderPlusIcon className="size-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-px p-1">{renderNodes(tree, 0)}</div>
      </ScrollArea>
    </div>
  );
}

function renderEmpty(depth: number) {
  return (
    <span
      className="text-muted-foreground/60 py-1 text-xs italic"
      style={{ paddingLeft: `${depth * 12 + 24}px` }}
    >
      empty
    </span>
  );
}
