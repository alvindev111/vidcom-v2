"use client";

import * as React from "react";
import { CheckIcon, CopyIcon, DownloadIcon, Loader2Icon } from "lucide-react";

import {
  MOTION_LIBRARIES,
  type MotionLibrary,
  type MotionLibraryId,
} from "@vidcom/contracts";
import { Button } from "@/components/ui/button";
import type { FileNode } from "@/lib/studio/types";

interface Installed {
  scriptTag: string;
  importSpecifier: string | null;
}

function flatten(nodes: readonly FileNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === "file") into.add(node.path);
    if (node.children) flatten(node.children, into);
  }
  return into;
}

/**
 * The snippet to paste once a library is vendored. Recomputed on the client from
 * the same catalogue the server writes from, so a stale response never shows a
 * path the project does not have.
 */
function snippetFor(library: MotionLibrary): Installed {
  return library.loader === "module"
    ? {
        scriptTag: `<script type="module" src="${library.entry}"></script>`,
        importSpecifier: `./${library.entry}`,
      }
    : { scriptTag: `<script src="${library.entry}"></script>`, importSpecifier: null };
}

/**
 * Vendors a pinned motion library into the open project.
 *
 * Presence is read from the project file tree rather than a dedicated endpoint —
 * the tree is already loaded, and the vendored file being on disk is exactly
 * what "installed" means.
 */
export function MotionLibraryPanel({
  projectId,
  tree,
  onProjectChanged,
}: {
  projectId: string;
  tree: FileNode[];
  onProjectChanged: () => void;
}) {
  const [pending, setPending] = React.useState<MotionLibraryId | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const files = React.useMemo(() => flatten(tree, new Set<string>()), [tree]);

  const install = async (library: MotionLibrary) => {
    setPending(library.id);
    setError(null);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/motion-libraries`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ libraryId: library.id }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string } | string;
        } | null;
        setError(typeof payload?.error === "string"
          ? payload.error
          : payload?.error?.message ?? `install failed (${response.status})`);
        return;
      }
      onProjectChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "install failed");
    } finally {
      setPending(null);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied((current) => (current === value ? null : current)), 1_500);
    } catch {
      setError("clipboard is unavailable — select the snippet and copy it manually");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-[11px]">
        Libraries are copied into <code className="font-mono">assets/vendor/</code> at a pinned
        version. Loading one from a CDN instead costs the render its reproducible flag and resolves
        nothing offline.
      </p>

      <div className="flex flex-col gap-2">
        {MOTION_LIBRARIES.map((library) => {
          const present = library.files.every((file) => files.has(file.projectPath));
          const snippet = snippetFor(library);
          return (
            <div key={library.id} className="rounded-md border p-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium">{library.id}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">
                      {library.version}
                    </span>
                    {library.loader === "module" ? (
                      <span className="text-muted-foreground rounded border px-1 text-[10px]">
                        ES module
                      </span>
                    ) : null}
                  </div>
                  <p className="text-muted-foreground truncate text-[11px]">{library.role}</p>
                </div>

                {present ? (
                  <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
                    <CheckIcon className="size-3" />
                    Vendored
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={pending !== null}
                    onClick={() => install(library)}
                  >
                    {pending === library.id ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <DownloadIcon className="size-3" />
                    )}
                    Add
                  </Button>
                )}
              </div>

              {present ? (
                <div className="mt-2 flex flex-col gap-1">
                  {[
                    ["Tag", snippet.scriptTag] as const,
                    ...(snippet.importSpecifier
                      ? ([["Import", snippet.importSpecifier]] as const)
                      : []),
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center gap-1.5">
                      <span className="text-muted-foreground w-12 shrink-0 text-[10px]">
                        {label}
                      </span>
                      <code className="bg-muted min-w-0 flex-1 truncate rounded px-1.5 py-0.5 font-mono text-[10px]">
                        {value}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0"
                        aria-label={`Copy ${label.toLowerCase()}`}
                        onClick={() => copy(value)}
                      >
                        {copied === value ? (
                          <CheckIcon className="size-3" />
                        ) : (
                          <CopyIcon className="size-3" />
                        )}
                      </Button>
                    </div>
                  ))}
                  {snippet.importSpecifier ? (
                    <p className="text-muted-foreground text-[10px]">
                      This build installs no global — import the specifier inside your own{" "}
                      <code className="font-mono">&lt;script type=&quot;module&quot;&gt;</code>.
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-[10px]">
                      Call it through the{" "}
                      <code className="font-mono">{library.globalName}</code> global.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {error ? <p className="text-destructive text-[11px]">{error}</p> : null}
    </div>
  );
}
