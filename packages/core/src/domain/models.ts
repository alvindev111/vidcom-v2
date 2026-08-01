import type {
  ContentHash,
  Diagnostic,
  ProjectId,
  ProjectSummaryDto,
  RelPath,
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
  kind: "file" | "directory";
}

/** One project tree entry returned by the workspace adapter. */
export interface FileNode {
  path: RelPath;
  name: string;
  kind: "file" | "folder";
  children?: FileNode[];
}

/** Parsed composition model shared by all project snapshot views. */
export interface CompositionModel {
  project: ProjectSummaryDto;
  scenes: unknown[];
  rootTrack: unknown | null;
  diagnostics: Diagnostic[];
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
    };
