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
  /**
   * mtime + size as of the read. Sent back on save so a write can be refused
   * when the agent or the SDK has rewritten the file in the meantime.
   */
  version: string;
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
  /** The referenced project file is gone; the clip is shown as missing its source. */
  missing: boolean;
}

/** One GSAP tween authored against an element, read statically from the source. */
export interface SceneEffect {
  id: string;
  /** `to`, `from`, `fromTo`, `set` — how the tween was authored. */
  method: string;
  /** Seconds from the start of the owning scene. */
  start: number;
  duration: number;
  ease: string | null;
  /** position / scale / size / rotation / visual, when the parser classified it. */
  propertyGroup: string | null;
}

/** A row inside a scene: an element with its own timing, its tweens, or both. */
export interface SceneElement {
  /** Element id or the tween's target selector — unique within the scene. */
  id: string;
  /** Exact authored data-hf-id. Structural paths remain read-only. */
  authoredId: string | null;
  label: string;
  kind: "image" | "video" | "audio" | "element";
  /** Own clip timing relative to the scene, when the element carries one. */
  start: number | null;
  duration: number | null;
  /** `src` for a media element, so a lane can name the file it plays. */
  src: string | null;
  /** VidCom-owned base-position offset; null for untouched or read-only targets. */
  layoutOffset: { x: number; y: number } | null;
  positionEditable: boolean;
  effects: SceneEffect[];
}

/**
 * The entry document's own track: root-level media (the A-roll) and the tweens
 * authored in `index.html` that move it.
 *
 * Not a scene — it has no composition host of its own — but it holds the most
 * important clip in a footage-led composition, and without a lane of its own the
 * video is invisible on the timeline.
 */
export interface RootTrack {
  /** Root composition id, for labelling. */
  id: string;
  duration: number;
  elements: SceneElement[];
  unresolvedEffects: number;
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
  /** Time the script diverged from audio, or null when narration is current or legacy-unknown. */
  staleSince: string | null;
}

export interface Scene {
  id: string;
  /** Sub-composition file, or null for a scene authored inline in index.html. */
  src: string | null;
  /** Project-relative file that owns this scene's authored elements. */
  sourceFile: string;
  role: "root" | "story" | "transition" | "overlay" | "credit" | "utility";
  start: number;
  duration: number;
  trackIndex: number;
  block: SceneBlock | null;
  isTransition: boolean;
  media: SceneMedia[];
  /** On-screen copy found in the scene, in document order. */
  script: SceneScriptLine[];
  narration: Narration | null;
  /** Elements and tweens inside the scene, for the timeline's expanded rows. */
  elements: SceneElement[];
  /**
   * Tweens the static parser could not resolve — targets built in a loop at
   * runtime. Surfaced as a count so the timeline can say so instead of
   * silently showing an incomplete scene.
   */
  unresolvedEffects: number;
}
