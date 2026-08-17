import type { Actor, ContentHash, PreviewSettingsDto, ProjectId, RelPath } from "@vidcom/contracts";

import type { PendingMountFailure, StagedFileSource } from "./types";

/** Source and history intent attached to one project mutation inside Core. */
export interface MutationOrigin {
  kind: "ui" | "mcp" | "cli" | "system";
  /** Studio session that authored the mutation, or `null` for every non-UI source. */
  sessionId: string | null;
  /** Human-readable undo label chosen by the server or use case, never by transport input. */
  label: string | null;
  historyAction: "record" | "undo" | "redo" | "ignore";
  /** Reservation for an inverse mutation, or `null` for record and ignored mutations. */
  historyOperation: { id: string; targetReceiptId: string } | null;
}

/** Maps the existing actor boundary to a redacted origin that intentionally bypasses UI history. */
export function ignoredMutationOriginForActor(actor: Actor): MutationOrigin {
  const kind = actor === "user"
    ? "ui"
    : actor === "agent"
      ? "mcp"
      : actor === "cli-external"
        ? "cli"
        : "system";
  return { kind, sessionId: null, label: null, historyAction: "ignore", historyOperation: null };
}

/** Byte interpretation retained with an undo content reference. */
export type UndoContentEncoding = "utf8" | "binary";

/** Bounded-memory reference to content needed by a later inverse mutation. */
export type UndoContentRef =
  | {
      kind: "inline";
      bytes: Uint8Array;
      encoding: UndoContentEncoding;
      contentHash: ContentHash;
    }
  | {
      kind: "object";
      contentHash: ContentHash;
      encoding: UndoContentEncoding;
    };

/** Content-addressed retention used by live history without persisting the history stack. */
export interface UndoContentPort {
  /** Retains caller bytes inline or in object storage and returns an immutable reference. */
  retainBytes(
    bytes: Uint8Array,
    encoding: UndoContentEncoding,
    storage: "inline" | "object",
  ): Promise<UndoContentRef>;
  /** Streams a staged regular file into leased object storage after verifying its declared hash. */
  retainFile(source: StagedFileSource, encoding: UndoContentEncoding): Promise<UndoContentRef>;
  /** Resolves inline bytes directly or an object as an opaque staged-file source. */
  resolve(ref: UndoContentRef): Promise<Uint8Array | StagedFileSource>;
  /** Releases live object leases; physical cleanup remains asynchronous and reference-aware. */
  release(refs: readonly UndoContentRef[]): void;
}

/** Typed dependency state read by a mutation without owning that path. */
export interface MutationReadGuard {
  path: RelPath;
  state: { kind: "file"; contentHash: ContentHash } | { kind: "directory" };
}

/** One receipt step with undo bytes kept only for operations declared undoable by Core. */
export type MutationReceiptStep =
  | {
      kind: "file";
      undoable: true;
      path: RelPath;
      beforeContent: UndoContentRef | null;
      afterContent: UndoContentRef | null;
      fromHash: ContentHash | null;
      toHash: ContentHash | null;
    }
  | {
      kind: "file";
      undoable: false;
      path: RelPath;
      fromHash: ContentHash | null;
      toHash: ContentHash | null;
      omittedReason: "not-undoable";
    }
  | {
      kind: "directory";
      undoable: boolean;
      op: "mkdir" | "rmdir";
      path: RelPath;
      existedBefore: boolean;
    }
  | {
      kind: "pending-mount";
      undoable: true;
      operationId: string;
      before: { state: "uploaded_unmounted"; lastFailure: PendingMountFailure | null };
      after: { state: "mounted"; sceneId: string; revision: number };
    }
  | {
      kind: "entity";
      undoable: boolean;
      entity: "preview-settings";
      backingPath: RelPath;
      beforeState: PreviewSettingsDto | null;
      afterState: PreviewSettingsDto;
      fromRevision: number;
      toRevision: number;
      fromHash: ContentHash | null;
      toHash: ContentHash;
    };

/** Stable post-commit account of one complete WriteAuthority mutation. */
export interface MutationReceipt {
  /** Durable identity in the form `journal:<decimal JournalId>`. */
  id: string;
  projectId: ProjectId;
  origin: MutationOrigin;
  steps: MutationReceiptStep[];
  /** Canonical paths actually changed by the mutation, excluding read-only guards. */
  paths: RelPath[];
  readGuards: MutationReadGuard[];
  projectRevision: number;
  at: string;
  undoable: boolean;
}

/** Non-throwing observer acknowledgement for reservation and receipt delivery. */
export type EmitResult = { ok: true } | { ok: false; reason: string };

/** Post-commit history observer kept behind a Core-owned, non-throwing port. */
export interface MutationObserverPort {
  /** Claims the prepared undo/redo reservation immediately before publish. */
  claimHistoryOperation(projectId: ProjectId, origin: MutationOrigin): EmitResult;
  /** Returns an uncommitted undo/redo reservation to a safe state. */
  abortHistoryOperation(projectId: ProjectId, origin: MutationOrigin): void;
  /** Settles and blocks the selected history direction after a precondition conflict. */
  blockHistoryOperation(projectId: ProjectId, origin: MutationOrigin, paths: RelPath[]): void;
  /** Accepts one stable receipt after commit; duplicate IDs must be idempotent. */
  emit(receipt: MutationReceipt): EmitResult;
  /** Applies an external-change barrier after the watcher has excluded own-write echoes. */
  observeExternalChange(projectId: ProjectId, paths: RelPath[]): void;
  /** Blocks every live history for a project after observer desynchronization. */
  invalidateProject(projectId: ProjectId, reason: "history-desync"): void;
}

/** Explicit P0 bridge until the session-owned history observer is installed in P3. */
export const NOOP_MUTATION_OBSERVER: MutationObserverPort = Object.freeze({
  claimHistoryOperation: () => ({ ok: true as const }),
  abortHistoryOperation() {},
  blockHistoryOperation() {},
  emit: () => ({ ok: true as const }),
  observeExternalChange() {},
  invalidateProject() {},
});
