"use client";

import * as React from "react";
import { LayersIcon, MusicIcon, PackageIcon, SlidersHorizontalIcon, SparklesIcon } from "lucide-react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchApi } from "@/lib/api/services";
import { fileVersionMap } from "@/lib/studio/file-version-cache";
import { sceneSettings } from "@/lib/studio/preview-settings";
import { mutationChangeSeq, type ProjectChanged } from "@/lib/studio/preview-reload";
import type { FileNode, Scene, SceneScriptLine, SourceFile } from "@/lib/studio/types";
import { CatalogRail } from "./catalog-rail";
import { MotionLibraryPanel } from "./motion-library-panel";
import { BgmPanel } from "./bgm-panel";
import { PreviewEditor } from "./preview-editor";
import { SceneDetail } from "./scene-detail";
import { SceneStoryboard } from "./scene-storyboard";
import type { usePreviewSettings } from "./use-preview-settings";
import { useStudioSession } from "./studio-session-context";

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
  projectId,
  projectSlug,
  scenes,
  tree,
  files,
  preview,
  selectedId,
  onSeek,
  onSelectScene,
  onProjectChanged,
  projectRevision,
  frameRate,
}: {
  projectId: string;
  projectSlug: string;
  scenes: Scene[];
  tree: FileNode[];
  files: SourceFile[];
  /** Preview settings shared with the timeline, so both write the same file. */
  preview: ReturnType<typeof usePreviewSettings>;
  selectedId: string;
  onSeek: (seconds: number) => void;
  onSelectScene: (scene: Scene) => void;
  /** Called after a successful write so the page re-reads the project. */
  onProjectChanged: ProjectChanged;
  projectRevision: number;
  frameRate: number;
}) {
  const studio = useStudioSession();
  const [inspectorTab, setInspectorTab] = React.useState("scene");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // A catalog install reports its new scene id before the refreshed snapshot has
  // arrived. The id is transient intent rather than rendered state, so it lives in
  // a ref: the effect below fires when the refreshed scenes arrive and selects it
  // through the same handler a storyboard click uses.
  const pendingSceneId = React.useRef<string | null>(null);
  const hashes = React.useRef(fileVersionMap(files));
  const submitQueue = React.useRef<Promise<void>>(Promise.resolve());

  React.useEffect(() => {
    hashes.current = fileVersionMap(files);
  }, [files]);

  React.useEffect(() => {
    const wanted = pendingSceneId.current;
    if (wanted === null) return;
    const created = scenes.find((scene) => scene.id === wanted);
    if (!created) return;
    pendingSceneId.current = null;
    onSelectScene(created);
  }, [onSelectScene, scenes]);

  const selected =
    scenes.find((scene) => scene.id === selectedId) ?? scenes[0] ?? null;
  const transitions = scenes.filter((scene) => scene.isTransition);

  const performSubmit = async (edit: Edit) => {
    setPending(true);
    setError(null);
    try {
      const isV1 = edit.action === "timing" || edit.action === "script";
      const file = edit.action === "script" ? edit.file : "index.html";
      let expectedContentHash = hashes.current.get(file);
      if (isV1 && !expectedContentHash) {
        const current = await fetchApi(`/api/v1/projects/${projectId}/files?path=${encodeURIComponent(file)}`);
        const currentBody = await current.json() as { file?: { contentHash?: string } };
        expectedContentHash = currentBody.file?.contentHash;
        if (expectedContentHash) hashes.current.set(file, expectedContentHash);
      }
      const response = await fetchApi((isV1
        ? edit.action === "timing"
          ? `/api/v1/projects/${projectId}/scenes/${edit.sceneId}`
          : `/api/v1/projects/${projectId}/scenes/${edit.sceneId}/script`
        : `/api/hf/${projectSlug}/scene`) as `/api/${string}`, studio.request({
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit.action === "timing"
          ? { timing: { start: edit.start, duration: edit.duration, trackIndex: edit.trackIndex }, expectedContentHash }
          : edit.action === "script"
            ? { file: edit.file, elementId: edit.elementId, text: edit.text, expectedContentHash }
            : edit),
      }));
      const payload = (await response.json().catch(() => null)) as {
        file?: { path: string; contentHash: string };
        changeSeq?: number | null;
        error?: { message?: string } | string;
      } | null;
      if (!response.ok) {
        setError(typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? `save failed (${response.status})`);
        return;
      }
      if (payload?.file) hashes.current.set(payload.file.path, payload.file.contentHash);
      onProjectChanged(mutationChangeSeq(payload));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "save failed");
    } finally {
      setPending(false);
    }
  };

  const submit = (edit: Edit): Promise<void> => {
    // Blur can enqueue the next script line before the snapshot carrying the
    // first write arrives. Serialize inspector mutations so the second write
    // reads the hash published by the first instead of racing it with a stale
    // expectedContentHash.
    const current = submitQueue.current.then(() => performSubmit(edit));
    submitQueue.current = current.catch(() => undefined);
    return current;
  };

  const busy = pending || preview.pending;
  const problem = error ?? preview.error;

  return (
    <ResizablePanelGroup orientation="vertical">
      <ResizablePanel defaultSize="52" minSize="25">
        <ScrollArea className="bg-sidebar h-full">
          <SceneStoryboard
            projectId={projectId}
            scenes={scenes}
            projectRevision={projectRevision}
            frameRate={frameRate}
            settings={preview.settings}
            selectedId={selected?.id ?? ""}
            entryContentHash={files.find((file) => file.path === "index.html")?.version ?? null}
            // Selecting a card moves the preview to that beat — the point of a
            // storyboard is to jump around by looking, not by scrubbing.
            onSelect={onSelectScene}
            onProjectChanged={onProjectChanged}
          />
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="48" minSize="20">
        <Tabs value={inspectorTab} onValueChange={setInspectorTab} className="h-full min-h-0 gap-0">
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
              Look & subtitles
            </TabsTrigger>
            <TabsTrigger value="motion" className="h-8 gap-1.5 text-xs">
              <SparklesIcon className="size-3.5" />
              Motion & sound
            </TabsTrigger>
            <TabsTrigger value="templates" className="h-8 gap-1.5 text-xs">
              <PackageIcon className="size-3.5" />
              Add scene
            </TabsTrigger>
            <TabsTrigger value="music" className="h-8 gap-1.5 text-xs">
              <MusicIcon className="size-3.5" />
              Music
            </TabsTrigger>
          </TabsList>

          <InspectorGuide tab={inspectorTab} selectedSceneId={selected?.id ?? null} />

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

          <TabsContent value="music" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="p-3">
                <BgmPanel
                  projectId={projectId}
                  currentTrackPath={preview.settings.bgm.track?.path ?? null}
                  revision={preview.currentRevision()}
                  tree={tree}
                  onProjectChanged={onProjectChanged}
                />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="templates" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="p-3">
                <CatalogRail
                  projectId={projectId}
                  projectRevision={preview.currentProjectRevision()}
                  sceneCount={scenes.length}
                  selectedSceneId={selected?.id ?? null}
                  onProjectChanged={onProjectChanged}
                  onSelectScene={(sceneId) => { pendingSceneId.current = sceneId; }}
                />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="motion" className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="p-3">
                <MotionLibraryPanel
                  projectId={projectId}
                  tree={tree}
                  onProjectChanged={onProjectChanged}
                  selectedSceneId={selected?.id ?? null}
                  sceneSettings={selected ? sceneSettings(preview.settings, selected.id) : null}
                  settingsPending={preview.pending}
                  settingsError={preview.error}
                  onSaveSettings={(patch) => {
                    if (selected) preview.patchScene(selected.id, patch);
                  }}
                />
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

const INSPECTOR_GUIDE = {
  scene: ["Edit this scene", "Start with timing or on-screen text; Save updates the preview and creates one undo step."],
  preview: ["Change the finished look", "Choose a palette, subtitle style, or background treatment; each control rebuilds the visible preview."],
  motion: ["Add motion and scene sound", "Choose the selected scene and apply a motion recipe or transition/reveal sound, then preview it immediately."],
  templates: ["Add a new storytelling beat", "Pick a template or block and choose where it should be mounted; the new scene is selected after install."],
  music: ["Choose the music bed", "Preview a track first, then Install to attach it to this project. Volume and looping remain under Look & subtitles."],
} as const;

function InspectorGuide({ tab, selectedSceneId }: { tab: string; selectedSceneId: string | null }) {
  const guide = INSPECTOR_GUIDE[tab as keyof typeof INSPECTOR_GUIDE] ?? INSPECTOR_GUIDE.scene;
  return (
    <div className="border-b bg-muted/25 px-3 py-2" role="note" aria-label={`${guide[0]} guide`}>
      <p className="text-xs font-medium">{guide[0]}{selectedSceneId && tab !== "templates" && tab !== "music" ? ` · ${selectedSceneId}` : ""}</p>
      <p className="text-muted-foreground mt-0.5 text-[11px]">{guide[1]}</p>
    </div>
  );
}
