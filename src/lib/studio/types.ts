export interface FileNode {
  /** Path relative to the project root — unique, used as React key and selection id. */
  path: string;
  name: string;
  kind: "file" | "folder";
  children?: FileNode[];
}

export interface SourceFile {
  path: string;
  /** Raw source, split per line by the code view. */
  code: string;
  /** 1-based line numbers that open a foldable block. */
  foldableLines: number[];
  saved: boolean;
}

export interface TimelineClip {
  id: string;
  label: string;
  /** Seconds from the start of the composition. */
  start: number;
  end: number;
}

export interface TimelineTrack {
  id: string;
  label: string;
  visible: boolean;
  clips: TimelineClip[];
}

export interface TimelineSection {
  id: string;
  label: string;
  tracks: TimelineTrack[];
}

export type AgentId = "claude" | "codex";

export interface TerminalLine {
  kind: "command" | "output" | "muted" | "accent";
  text: string;
}

export interface SceneMedia {
  kind: "image" | "video" | "audio";
  /** URL under /api/hf/<slug>/files, already resolved against the host file. */
  url: string;
  src: string;
  start: number | null;
  duration: number | null;
}

/** Provenance for a scene installed from the HyperFrames registry. */
export interface SceneBlock {
  name: string;
  title: string | null;
  description: string | null;
  /** resolveBlockCategory() of the item's tags — "transitions", "vfx", … */
  category: string | null;
  tags: string[];
}

/** One editable line of on-screen copy, addressed by its SDK hf-id. */
export interface SceneScriptLine {
  /** hf-id (scoped for sub-composition elements) used as the setText target. */
  id: string;
  text: string;
  /** Project-relative file that owns the element. */
  file: string;
}

/**
 * TTS state for a scene's narration. Real audio comes from  * (Kokoro-82M); this app records the job and its command, and marks whether the
 * audio was actually produced.
 */
export interface Narration {
  sceneId: string;
  text: string;
  voice: string;
  /** "mock" = job recorded but no audio rendered; "generated" = wav on disk. */
  status: "mock" | "generated";
  /** Project-relative path the audio would live at. */
  audioPath: string;
  /** The CLI command that produces the real audio. */
  command: string;
  revision: number;
  updatedAt: string;
}

export interface Scene {
  id: string;
  /** Sub-composition file, or null for a scene authored inline in index.html. */
  src: string | null;
  start: number;
  duration: number;
  trackIndex: number;
  block: SceneBlock | null;
  isTransition: boolean;
  media: SceneMedia[];
  /** On-screen copy found in the scene, in document order. */
  script: SceneScriptLine[];
  narration: Narration | null;
}
