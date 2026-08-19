"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  CodeIcon,
  LayersIcon,
  SparklesIcon,
} from "lucide-react";

import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import type { FileNode, Scene, SourceFile } from "@/lib/studio/types";
import { confirmDiscard } from "@/lib/studio/unsaved-guard";
import { AiComposerPanel } from "./ai-composer-panel";
import { CodePane } from "./code-pane";
import { ScenePane } from "./scene-pane";
import type { usePreviewSettings } from "./use-preview-settings";

const TRIGGER_CLASS = "h-9 flex-1 rounded-md border border-transparent";

/**
 * Left half of the studio. Switching tabs swaps only this pane — the preview,
 * playback bar and timeline on the right stay mounted and keep playing.
 */
export function SourcePane({
  projectId,
  projectSlug,
  tree,
  files,
  scenes,
  preview,
  selectedId,
  onSeek,
  onSelectScene,
  onProjectChanged,
  projectRevision,
}: {
  projectId: string;
  projectSlug: string;
  tree: FileNode[];
  files: SourceFile[];
  scenes: Scene[];
  preview: ReturnType<typeof usePreviewSettings>;
  selectedId: string;
  onSeek: (seconds: number) => void;
  onSelectScene: (scene: Scene) => void;
  onProjectChanged: ProjectChanged;
  projectRevision: number;
}) {
  const [tab, setTab] = React.useState("code");

  return (
    <Tabs
      value={tab}
      onValueChange={setTab}
      className="h-full min-h-0 gap-0 overflow-hidden"
    >
      <div className="bg-sidebar flex h-12 shrink-0 items-center gap-2 px-2">
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          aria-label="Back to projects"
        >
          {/* Leaving the project is the third way a draft can be lost, so it
              asks with the same question the other two do. */}
          <Link href="/" onClick={(event) => { if (!confirmDiscard()) event.preventDefault(); }}>
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>

        <TabsList variant="line" className="h-9 grow gap-2 bg-transparent p-0">
          <TabsTrigger value="code" className={TRIGGER_CLASS}>
            <CodeIcon />
            Code
          </TabsTrigger>
          <TabsTrigger value="scene" className={TRIGGER_CLASS}>
            <LayersIcon />
            Video Scene
          </TabsTrigger>
          {/* The agent tab keeps its accent outline whether or not it is active,
              so the AI surface stays identifiable from the other tabs. */}
          <TabsTrigger
            value="ai"
            className={`${TRIGGER_CLASS} border-studio-accent/70! dark:border-studio-accent/70!`}
          >
            <SparklesIcon />
            AI Composer
          </TabsTrigger>
        </TabsList>

        <ModeToggle />
      </div>

      <TabsContent value="code" className="min-h-0 flex-1 border-t">
        <CodePane
          projectId={projectId}
          projectSlug={projectSlug}
          tree={tree}
          files={files}
          onProjectChanged={onProjectChanged}
          projectRevision={projectRevision}
        />
      </TabsContent>
      <TabsContent value="scene" className="min-h-0 flex-1 border-t">
        <ScenePane
          projectId={projectId}
          projectSlug={projectSlug}
          scenes={scenes}
          tree={tree}
          files={files}
          preview={preview}
          selectedId={selectedId}
          onSeek={onSeek}
          onSelectScene={onSelectScene}
          onProjectChanged={onProjectChanged}
        />
      </TabsContent>
      <TabsContent value="ai" className="min-h-0 flex-1 border-t">
        <AiComposerPanel
          projectId={projectId}
          projectSlug={projectSlug}
          onProjectChanged={onProjectChanged}
        />
      </TabsContent>
    </Tabs>
  );
}
