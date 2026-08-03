export interface HfProject {
  id: string;
  slug: string;
  title: string;
  description?: string;
  width: number;
  height: number;
  duration: number;
  updatedAt: string;
  sceneCount: number;
  revision: number;
}

export interface SceneEffect {
  id: string;
  method: string;
  start: number;
  duration: number;
  ease: string | null;
  propertyGroup: string | null;
}

export interface SceneElement {
  id: string;
  label: string;
  kind: "image" | "video" | "audio" | "element";
  start: number | null;
  duration: number | null;
  src: string | null;
  effects: SceneEffect[];
}

export interface SceneMedia {
  kind: "image" | "video" | "audio";
  url: string;
  src: string;
  start: number | null;
  duration: number | null;
}

export interface SceneScriptLine { id: string; text: string; file: string }
export interface SceneBlock {
  name: string;
  title: string | null;
  description: string | null;
  category: string | null;
  tags: string[];
}
export interface Narration {
  sceneId: string;
  text: string;
  voice: string;
  status: "mock" | "generated";
  audioPath: string;
  command: string;
  revision: number;
  updatedAt: string;
  staleSince: string | null;
  provider?: string;
  durationSeconds?: number;
  words?: { text: string; startSeconds: number; endSeconds: number }[];
  wordTimingSource?: "engine" | "estimated";
  engine?: Record<string, string | number | boolean>;
}
export interface Scene {
  id: string;
  src: string | null;
  start: number;
  duration: number;
  trackIndex: number;
  block: SceneBlock | null;
  isTransition: boolean;
  media: SceneMedia[];
  script: SceneScriptLine[];
  narration: Narration | null;
  elements: SceneElement[];
  unresolvedEffects: number;
}
export interface RootTrack {
  id: string;
  duration: number;
  elements: SceneElement[];
  unresolvedEffects: number;
}
export interface CompositionHost {
  id: string;
  src: string | null;
  start: number;
  duration: number;
  trackIndex: number;
  element: Element;
}
