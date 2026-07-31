import {
  FileAudioIcon,
  FileCodeIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileNode } from "@/lib/studio/types";

const BY_EXTENSION: Record<
  string,
  { icon: typeof FileTextIcon; className: string }
> = {
  html: { icon: FileCodeIcon, className: "text-orange-600 dark:text-orange-400" },
  py: { icon: FileCodeIcon, className: "text-sky-600 dark:text-sky-400" },
  json: { icon: FileJsonIcon, className: "text-amber-600 dark:text-amber-400" },
  wav: { icon: FileAudioIcon, className: "text-teal-600 dark:text-teal-400" },
  txt: { icon: FileTextIcon, className: "text-muted-foreground" },
};

export function FileIcon({
  node,
  className,
}: {
  node: FileNode;
  className?: string;
}) {
  if (node.kind === "folder") {
    return (
      <FolderIcon className={cn("size-3.5 text-muted-foreground", className)} />
    );
  }

  const extension = node.name.split(".").pop() ?? "";
  const match = BY_EXTENSION[extension] ?? {
    icon: FileTextIcon,
    className: "text-muted-foreground",
  };
  const Icon = match.icon;

  return <Icon className={cn("size-3.5", match.className, className)} />;
}
