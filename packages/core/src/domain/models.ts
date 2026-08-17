import type {
  ContentHash,
  Diagnostic,
  ProjectId,
  ProjectSummaryDto,
  RelPath,
  SceneDto,
} from "@vidcom/contracts";

/** Absolute workspace path derived by the composition root, never by Core. */
export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };

/** Stable identity and derived location of one valid project. */
export interface ProjectRef {
  id: ProjectId;
  slug: string;
  root: AbsolutePath;
  entry: RelPath;
}

/** File content read together with its canonical digest. */
export interface FileContent {
  content: string;
  contentHash: ContentHash;
}

export interface BinaryContent {
  bytes: Uint8Array;
  contentHash: ContentHash;
}

/** Filesystem metadata exposed to Core without a Node stat object. */
export interface FileStat {
  size: number;
  modifiedAt: Date;
  kind: "file" | "directory" | "symlink" | "other";
}

/** Direct child metadata read without following symlinks. */
export interface DirectoryEntry {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
}

/** One project tree entry returned by the workspace adapter. */
export interface FileNode {
  path: RelPath;
  name: string;
  kind: "file" | "folder";
  children?: FileNode[];
}

/** One composition source already read by the parser with its digest and UTF-8 byte size. */
export interface CompositionSource {
  path: RelPath;
  contentHash: ContentHash;
  byteSize: number;
}

/** One local authored file reference resolved against the project-relative source that owns it. */
export interface CompositionReference {
  path: RelPath;
  owner: RelPath;
}

/** One factual text/font compatibility finding produced by an infrastructure inspector. */
export interface FontCompatibilityIssue {
  kind: "invalid-utf8" | "font-file-invalid" | "font-glyph-missing" | "font-coverage-unverified";
  sourceFile: RelPath;
  fontFamily?: string;
  fontFile?: RelPath;
  missingCodePoints?: number[];
  sample?: string;
}

/** Parsed composition model shared by all project snapshot views. */
export interface CompositionModel {
  project: ProjectSummaryDto;
  /** Authored root frame rate; adapters use the HyperFrames default when the attribute is absent. */
  frameRate?: number;
  scenes: SceneDto[];
  rootTrack: unknown | null;
  diagnostics: Diagnostic[];
  /** Entry and referenced sub-compositions in deterministic first-read order; no extra I/O is performed for hashing. */
  sources: CompositionSource[];
  /** Canonical local references only; external, data and project-escaping URLs are excluded. */
  references: CompositionReference[];
}

/** SDK-neutral composition mutation operation. */
export type CompositionOp =
  | {
      kind: "setText";
      target: string;
      value: string;
    }
  | {
      kind: "setTiming";
      target: string;
      value: { start?: number; duration?: number; trackIndex?: number };
    }
  | {
      kind: "addElement";
      target: string | null;
      value: { index: number; html: string };
    }
  | {
      kind: "removeElement";
      target: string;
    };
