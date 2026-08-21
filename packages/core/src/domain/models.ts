import type {
  ContentHash,
  Diagnostic,
  ProjectId,
  ProjectSummaryDto,
  RelPath,
  SceneDto,
} from "@vidcom/contracts";

import type { CaptionCue } from "./plan-caption-cues";
import type { WordTimingSource } from "./word-timings";

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

export interface FileTreePage {
  directory: RelPath | null;
  entries: FileNode[];
  nextCursor: string | null;
  totalEntries: number;
}

export interface WorkspaceTreeLimits {
  maxDepth: number;
  maxNodes: number;
  maxEntriesPerDirectory: number;
  maxSerializedBytes: number;
  maxDurationMs: number;
}

export const DEFAULT_WORKSPACE_TREE_LIMITS: Readonly<WorkspaceTreeLimits> = Object.freeze({
  maxDepth: 64,
  maxNodes: 10_000,
  maxEntriesPerDirectory: 2_000,
  maxSerializedBytes: 8 * 1024 * 1024,
  maxDurationMs: 5_000,
});

export type WorkspaceResourceLimitReason =
  | "depth"
  | "node_count"
  | "directory_entries"
  | "serialized_bytes"
  | "deadline";

export class WorkspaceResourceLimitError extends Error {
  readonly name = "WorkspaceResourceLimitError";

  constructor(
    readonly reason: WorkspaceResourceLimitReason,
    readonly limit: number,
    readonly actual: number,
  ) {
    super(`workspace resource limit ${reason} exceeded: ${actual} > ${limit}`);
  }
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
  /** Project authoring contract marker; version 9 enables strict generated-story gates. */
  agentKitVersion?: number | null;
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
    }
  | {
      kind: "setLayoutOffset";
      target: string;
      value: { x: number; y: number };
    }
  | {
      kind: "replaceCaptions";
      target: string;
      value: { cues: CaptionCue[]; timingSource: WordTimingSource };
    };
