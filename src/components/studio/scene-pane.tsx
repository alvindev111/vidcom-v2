"use client";

import * as React from "react";
import { LayersIcon, SlidersHorizontalIcon } from "lucide-react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { sceneSettings } from "@/lib/studio/preview-settings";
import type { FileNode, Scene, SceneScriptLine } from "@/lib/studio/types";
import { PreviewEditor } from "./preview-editor";
import { SceneDetail } from "./scene-detail";
import { SceneStoryboard } from "./scene-storyboard";
import type { usePreviewSettings } from "./use-preview-settings";

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
  preview,
  selectedId,
  onSeek,
  onSelectScene,
  onProjectChanged,
}: {
  projectSlug: string;
  scenes: Scene[];
  tree: FileNode[];
  /** Preview settings shared with the timeline, so both write the same file. */
  preview: ReturnType<typeof usePreviewSettings>;
  selectedId: string;
  onSeek: (seconds: number) => void;
  onSelectScene: (scene: Scene) => void;
  /** Called after a successful write so the page re-reads the project. */
  onProjectChanged: () => void;
}) {
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

  const busy = pending || preview.pending;
  const problem = error ?? preview.error;

  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="52" minSize="25">
        <ScrollArea className="bg-sidebar h-full">
          <SceneStoryboard
            projectSlug={projectSlug}
            scenes={scenes}
            tree={tree}
            settings={preview.settings}
            selectedId={selected?.id ?? ""}
            // Selecting a card moves the preview to that beat — the point of a
            // storyboard is to jump around by looking, not by scrubbing.
            onSelect={onSelectScene}
          />
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="48" minSize="20">
        <Tabs defaultValue="scene" className="h-full min-h-0 gap-0">
          <TabsList
            variant="line"
            className="h-9 shrink-0 justify-start gap-2 rounded-none border-b bg-transparent px-3"
          >
            <TabsTrigger value="scene" className="h-8 gap-1.5 text-xs">
              <LayersIcon className="size-3.5" />
              Scene
            </TabsTrigger>
            <TabsTrigger value="preview" className="h-8 gap-1.5 text-xs">
              <SlidersHorizontalIcon className="size-3.5" />
              Preview editor
            </TabsTrigger>
          </TabsList>

          <TabsContent value="scene" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              {selected ? (
                <SceneDetail
                  scene={selected}
                  settings={sceneSettings(preview.settings, selected.id)}
                  transitions={transitions}
                  pending={busy}
                  error={problem}
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
                  onSaveSettings={(patch) =>
                    preview.patchScene(selected.id, patch)
                  }
                />
              ) : (
                <p className="text-muted-foreground p-4 text-xs">
                  No scene selected.
                </p>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="preview" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              {problem ? (
                <p className="text-destructive px-4 pt-3 text-xs" role="alert">
                  {problem}
                </p>
              ) : null}
              <PreviewEditor
                settings={preview.settings}
                pending={busy}
                onPatch={preview.patch}
                onUploadBgm={preview.uploadBgm}
              />
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
