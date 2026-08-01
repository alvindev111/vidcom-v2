import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { StudioShell } from "@/components/studio/studio-shell";
import { readPreviewSettings } from "@/lib/hyperframes/preview-settings.server";
import { readRootTrack } from "@/lib/hyperframes/root-track.server";
import {
  readProject,
  readProjectTree,
  readSourceFile,
} from "@/lib/hyperframes/projects.server";
import { readScenes } from "@/lib/hyperframes/scenes.server";

type ComposerParams = { params: Promise<{ slug: string }> };

// Projects live on disk and are edited outside the app, so never prerender them.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: ComposerParams): Promise<Metadata> {
  const { slug } = await params;
  const project = readProject(slug);
  return { title: project ? `${project.title} · vidcom` : "vidcom" };
}

export default async function ComposerPage({ params }: ComposerParams) {
  const { slug } = await params;
  const project = readProject(slug);
  if (!project) notFound();

  const entry = readSourceFile(slug, project.entry);
  const scenes = await readScenes(slug);

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <StudioShell
        projectSlug={project.slug}
        previewUrl={`/api/hf/${project.slug}/preview`}
        aspectRatio={project.width / project.height}
        authoredDuration={project.duration}
        tree={readProjectTree(slug)}
        files={entry ? [entry] : []}
        scenes={scenes}
        rootTrack={readRootTrack(slug)}
        previewSettings={readPreviewSettings(slug)}
      />
    </div>
  );
}
