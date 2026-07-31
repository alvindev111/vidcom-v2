"use client";

import * as React from "react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FileNode, Scene, SceneScriptLine } from "@/lib/studio/types";
import { SceneDetail } from "./scene-detail";
import { SceneStoryboard } from "./scene-storyboard";

type Edit =
  | {
      action: "timing";
      sceneId: string;
      start: number;
      duration: number;
      trackIndex: number;
    }
  | {
      action: "script";
      sceneId: string;
      file: string;
      elementId: string;
      text: string;
    }
  | { action: "tts"; sceneId: string; text: string };

/** Video Scene tab: storyboard on top, the selected scene's details below. */
export function ScenePane({
  projectSlug,
  scenes,
  tree,
  currentTime,
  onSeek,
  onProjectChanged,
}: {
  projectSlug: string;
  scenes: Scene[];
  tree: FileNode[];
  currentTime: number;
  onSeek: (seconds: number) => void;
  /** Called after a successful write so the page re-reads the project. */
  onProjectChanged: () => void;
}) {
  const [selectedId, setSelectedId] = React.useState(scenes[0]?.id ?? "");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const selected =
    scenes.find((scene) => scene.id === selectedId) ?? scenes[0] ?? null;
  const transitions = scenes.filter((scene) => scene.isTransition);

  const submit = async (edit: Edit) => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/hf/${projectSlug}/scene`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(payload?.error ?? `save failed (${response.status})`);
        return;
      }
      onProjectChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "save failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="52" minSize="25">
        <ScrollArea className="bg-sidebar h-full">
          <SceneStoryboard
            projectSlug={projectSlug}
            scenes={scenes}
            tree={tree}
            selectedId={selected?.id ?? ""}
            currentTime={currentTime}
            onSelect={(scene) => {
              setSelectedId(scene.id);
              // Selecting a card moves the preview to that beat — the point of
              // a storyboard is to jump around by looking, not by scrubbing.
              onSeek(scene.start);
            }}
          />
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="48" minSize="20">
        <ScrollArea className="h-full">
          {selected ? (
            <SceneDetail
              scene={selected}
              transitions={transitions}
              pending={pending}
              error={error}
              onSeek={onSeek}
              onSaveTiming={(timing) =>
                void submit({
                  action: "timing",
                  sceneId: selected.id,
                  ...timing,
                })
              }
              onSaveScriptLine={(line: SceneScriptLine, text: string) =>
                void submit({
                  action: "script",
                  sceneId: selected.id,
                  file: line.file,
                  elementId: line.id,
                  text,
                })
              }
              onRegenerateTts={(text: string) =>
                void submit({ action: "tts", sceneId: selected.id, text })
              }
            />
          ) : (
            <p className="text-muted-foreground p-4 text-xs">
              No scene selected.
            </p>
          )}
        </ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
