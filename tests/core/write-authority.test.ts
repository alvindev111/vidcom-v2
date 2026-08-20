import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { ErrorCode } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  err,
  serializePreviewSettings,
  WriteAuthority,
  type AbsolutePath,
  type BackupManifest,
  type BackupSource,
  type CompositeIntent,
  type CompositeReconcileOutcome,
  type CompositeResult,
  type EntityState,
  type JournalId,
  type MutationIntent,
  type MutationObserverPort,
  type MutationReceipt,
  type MutationCapture,
  type MutationCaptureExpectation,
  type MutationLandedState,
  type MutationPathLease,
  type MutationPublishContent,
  type MutationResult,
  type PendingMutation,
  type PendingMutationContext,
  type PendingMount,
  type PendingMountPort,
  type PendingMountTransition,
  type ProjectRef,
  type ResolvedPath,
  type StepIntent,
  type StagedAssetPort,
  type StagedFileSource,
  type UndoContentPort,
  type UndoContentRef,
  type WriteEnvelope,
  type WrittenStateTrackerPort,
} from "@vidcom/core";

const TEST_ORIGIN = { kind: "system", sessionId: null, label: null, historyAction: "ignore", historyOperation: null } as const;
const RECORD_ORIGIN = {
  kind: "ui",
  sessionId: "01K1ABCDEFGHJKMNPQRSTVWXYZ",
  label: "Edit project",
  historyAction: "record",
  historyOperation: null,
} as const;
const digest = (content: string | Uint8Array): ContentHash =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as ContentHash;

const projectId = "project_0001" as ProjectId;
const project: ProjectRef = {
  id: projectId,
  slug: "project",
  root: "/workspace/project" as AbsolutePath,
  entry: "index.html" as RelPath,
};

class FakeWorkspace {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly specialKinds = new Map<string, "symlink" | "other">();
  readonly directoryEntries = new Map<string, Array<{ name: string; kind: "file" | "directory" | "symlink" | "other" }>>();
  readonly captures = new Map<string, string | null>();
  writeDelayMs = 0;
  writeError: Error | null = null;
  writeFailure: ((path: ResolvedPath, content: string | Uint8Array) => boolean) | null = null;
  writes = 0;
  readonly resolvedPaths = new Map<string, string>();
  readonly rejectedPaths = new Set<string>();
  beforeDirectoryPublish: ((capture: Extract<MutationCapture, { kind: "directory" }>, action: "mkdir" | "rmdir") => void) | null = null;
  discardFailures = 0;
  discardAttempts = 0;
  captureRecovery = false;

  async resolve(_ref: ProjectRef, path: string) {
    if (this.rejectedPaths.has(path)) {
      return { ok: false as const, error: { reason: "not_allowed_for_purpose" as const } };
    }
    return { ok: true as const, value: (this.resolvedPaths.get(path) ?? path) as ResolvedPath };
  }
  async resolveMutation(ref: ProjectRef, path: string) {
    const resolved = await this.resolve(ref, path);
    return resolved.ok
      ? { ok: true as const, value: {
          target: resolved.value,
          canonicalRoot: ref.root as unknown as ResolvedPath,
          parents: [],
        } }
      : resolved;
  }
  async revalidateMutationPath() { return true; }
  async refreshMutationPath(lease: MutationPathLease) { return lease; }
  async resolveWorkspace(_root: AbsolutePath, path: RelPath) { return this.resolve(project, path); }
  async listProjects() { return [project]; }
  async readProjectRef(id: ProjectId) { return id === projectId ? project : null; }
  async readFile(path: ResolvedPath) {
    const content = this.files.get(path);
    return content === undefined ? null : { content, contentHash: digest(content) };
  }
  async readBytes(path: ResolvedPath) {
    const content = this.files.get(path);
    return content === undefined
      ? null
      : { bytes: new TextEncoder().encode(content), contentHash: digest(content) };
  }
  async readHash(path: ResolvedPath) {
    const content = this.files.get(path);
    return content === undefined ? null : digest(content);
  }
  async writeAtomic(path: ResolvedPath, content: string | Uint8Array) {
    this.writes += 1;
    if (this.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    if (this.writeError) throw this.writeError;
    if (this.writeFailure?.(path, content)) throw new Error("injected write failure");
    this.files.set(path, typeof content === "string" ? content : new TextDecoder().decode(content));
  }
  async exists(path: ResolvedPath) { return this.files.has(path); }
  async deleteAtomic(path: ResolvedPath) { this.files.delete(path); }
  async captureForMutation(
    target: ResolvedPath,
    expectation: MutationCaptureExpectation,
    journalId: JournalId,
    ordinal: number,
  ) {
    if (expectation !== null && typeof expectation === "object") {
      const actualState = this.directories.has(target)
        ? "directory" as const
        : this.files.has(target) ? "file" as const : "absent" as const;
      if (expectation.existedBefore !== (actualState === "directory")) {
        return { ok: false as const, error: { actualState } };
      }
      return {
        ok: true as const,
        value: {
          kind: "directory" as const,
          journalId,
          ordinal,
          target,
          rollbackPath: null,
          capturedHash: null,
          existedBefore: expectation.existedBefore,
        },
      };
    }
    const expectedHash = expectation;
    const current = this.files.get(target) ?? null;
    const actualHash = current === null ? null : digest(current);
    if (actualHash !== expectedHash) return { ok: false as const, error: { actualHash } };
    const rollbackPath = current === null
      ? null
      : `${target}.rollback-${journalId}-${ordinal}` as ResolvedPath;
    if (rollbackPath !== null) this.captures.set(rollbackPath, current);
    this.files.delete(target);
    if (this.captureRecovery) {
      this.files.set(target, "external replacement");
      return {
        ok: false as const,
        error: {
          reason: "recovery_required" as const,
          actualState: "file" as const,
          capture: { journalId, ordinal, target, rollbackPath, capturedHash: actualHash },
        },
      };
    }
    return {
      ok: true as const,
      value: { journalId, ordinal, target, rollbackPath, capturedHash: actualHash },
    };
  }
  async publishCaptured(capture: MutationCapture, content: MutationPublishContent) {
    if (capture.kind === "directory") {
      if (!content || typeof content !== "object" || content instanceof Uint8Array || !("action" in content)) return false;
      this.beforeDirectoryPublish?.(capture, content.action);
      this.beforeDirectoryPublish = null;
      if (content.action === "mkdir") {
        if (capture.existedBefore) return this.directories.has(capture.target);
        if (this.directories.has(capture.target) || this.files.has(capture.target)) return false;
        this.directories.add(capture.target);
        return true;
      }
      if (!this.directories.has(capture.target)) return false;
      if ((this.directoryEntries.get(capture.target)?.length ?? 0) > 0) return false;
      this.directories.delete(capture.target);
      return true;
    }
    if (content !== null && typeof content === "object" && !(content instanceof Uint8Array)) return false;
    if (this.files.has(capture.target)) return false;
    if (content === null) return true;
    this.writes += 1;
    if (this.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    if (this.writeError) throw this.writeError;
    if (this.writeFailure?.(capture.target, content)) throw new Error("injected write failure");
    this.files.set(capture.target, typeof content === "string" ? content : new TextDecoder().decode(content));
    return true;
  }
  async restoreCaptured(capture: MutationCapture, landedHash: MutationLandedState) {
    if (capture.kind === "directory") {
      if (!landedHash || typeof landedHash !== "object" || !("exists" in landedHash)) return false;
      if (this.directories.has(capture.target) !== landedHash.exists) return false;
      if (capture.existedBefore) this.directories.add(capture.target);
      else this.directories.delete(capture.target);
      return true;
    }
    if (landedHash !== null && typeof landedHash === "object") return false;
    const current = this.files.get(capture.target) ?? null;
    const currentHash = current === null ? null : digest(current);
    if (currentHash !== landedHash) return false;
    if (capture.rollbackPath === null) {
      this.files.delete(capture.target);
      return true;
    }
    const previous = this.captures.get(capture.rollbackPath);
    if (previous === undefined || previous === null) return false;
    if (this.writeFailure?.(capture.target, previous)) throw new Error("injected restore failure");
    this.files.set(capture.target, previous);
    this.captures.delete(capture.rollbackPath);
    return true;
  }
  async discardCapture(capture: MutationCapture) {
    this.discardAttempts += 1;
    if (this.discardFailures > 0) {
      this.discardFailures -= 1;
      throw new Error("injected discard failure");
    }
    if (capture.rollbackPath !== null) this.captures.delete(capture.rollbackPath);
  }
  async readTree() { return []; }
  async stat(path: ResolvedPath) {
    const specialKind = this.specialKinds.get(path);
    if (specialKind) return { size: 0, modifiedAt: new Date(0), kind: specialKind };
    if (this.directories.has(path)) {
      return { size: 0, modifiedAt: new Date(0), kind: "directory" as const };
    }
    const content = this.files.get(path);
    return content === undefined ? null : { size: content.length, modifiedAt: new Date(0), kind: "file" as const };
  }
  async readDirectory(path: ResolvedPath) { return this.directoryEntries.get(path) ?? []; }
}

class FakeJournal {
  pending: PendingMutation[] = [];
  aborted: Array<{ id: JournalId; reason: ErrorCode }> = [];
  commitError: Error | null = null;
  compositeCommitError: Error | null = null;
  compositeAbortError: Error | null = null;
  compositeOrphanError: Error | null = null;
  revision = 0;
  entityState: EntityState | null = null;
  recoveryRequired = false;
  gateChecks = 0;
  readonly compositePending = new Map<JournalId, StepIntent[]>();
  readonly compositeContextHistory: PendingMutationContext[] = [];
  readonly pendingMountTransitions: Array<PendingMountTransition | undefined> = [];
  readonly attachedBackups: Array<{ id: JournalId; backupId: string }> = [];
  readonly compositeAborted: JournalId[] = [];
  readonly compositeOrphaned: JournalId[] = [];
  readonly capturedSteps: Array<{ id: JournalId; ordinal: number; rollbackPath: ResolvedPath | null }> = [];

  async begin(intent: MutationIntent): Promise<JournalId> {
    const id = (this.pending.length + 1) as JournalId;
    this.pending.push({ id, ...intent });
    return id;
  }
  async commit(id: JournalId, result: MutationResult): Promise<number> {
    if (this.commitError) throw this.commitError;
    this.pending = this.pending.filter((entry) => entry.id !== id);
    if (result.kind === "entity") {
      this.entityState = {
        revision: (this.entityState?.revision ?? 0) + 1,
        contentHash: result.toHash,
        backingPath: "preview-settings.json" as RelPath,
      };
      return this.entityState.revision;
    }
    this.revision += 1;
    return this.revision;
  }
  async abort(id: JournalId, reason: ErrorCode) {
    this.pending = this.pending.filter((entry) => entry.id !== id);
    this.aborted.push({ id, reason });
  }
  async recover(id: JournalId, result: MutationResult) { return this.commit(id, result); }
  async orphan(id: JournalId) { this.pending = this.pending.filter((entry) => entry.id !== id); }
  async listPending() { return this.pending; }
  async latestRevision() { return this.revision || null; }
  async latestSourceRevision() { return this.revision || null; }
  async readRevisionRollbackPayload() {
    return err({ code: ErrorCode.NotFound, message: "unused" });
  }
  async readEntityState() { return this.entityState; }
  async findProjectRegistration() { return null; }
  async registerProject() {}
  async beginBootstrap(_registration: unknown, _seed: unknown, intent: MutationIntent) {
    return this.begin(intent);
  }
  async beginComposite(
    intent: CompositeIntent,
    steps: StepIntent[],
    context: PendingMutationContext,
    _authority?: unknown,
    _grant?: unknown,
    pending?: PendingMountTransition,
  ): Promise<JournalId> {
    void intent;
    void context;
    const id = (this.compositePending.size + 1) as JournalId;
    this.compositePending.set(id, steps);
    this.compositeContextHistory.push(context);
    this.pendingMountTransitions.push(pending);
    const single = steps.length === 1 ? steps[0] : null;
    if (single?.toHash) {
      this.pending.push({
        id,
        projectId: intent.projectId,
        kind: single.kind === "entity" ? "entity" : "file",
        path: single.path,
        entity: single.entity,
        fromHash: single.fromHash,
        toHash: single.toHash,
        previousContent: single.previousContent,
        actor: intent.actor,
      });
    }
    return id;
  }
  async markStepCaptured(id: JournalId, ordinal: number, rollbackPath: ResolvedPath | null) {
    this.capturedSteps.push({ id, ordinal, rollbackPath });
  }
  async attachBackup(id: JournalId, backupId: string) { this.attachedBackups.push({ id, backupId }); }
  async commitComposite(id: JournalId, result: CompositeResult): Promise<WriteEnvelope> {
    if (this.compositeCommitError || this.commitError) throw this.compositeCommitError ?? this.commitError;
    this.compositePending.delete(id);
    this.pending = this.pending.filter((entry) => entry.id !== id);
    this.revision += 1;
    const fileHashes: Record<string, ContentHash> = {};
    let entityRevision: number | null = null;
    for (const step of result.steps) {
      if (step.kind === "write") fileHashes[step.path] = step.toHash;
      if (step.kind === "entity") {
        this.entityState = {
          revision: (this.entityState?.revision ?? 0) + 1,
          contentHash: step.toHash,
          backingPath: "preview-settings.json" as RelPath,
        };
        entityRevision = this.entityState.revision;
        fileHashes[this.entityState.backingPath] = step.toHash;
      }
    }
    return { projectRevision: this.revision, entityRevision, fileHashes, diagnostics: result.diagnostics, changeSeq: this.revision };
  }

  async commitDerivedComposite(id: JournalId, result: CompositeResult): Promise<WriteEnvelope> {
    return this.commitComposite(id, result);
  }
  async abortComposite(id: JournalId, reason: ErrorCode) {
    if (this.compositeAbortError) throw this.compositeAbortError;
    this.compositePending.delete(id);
    this.pending = this.pending.filter((entry) => entry.id !== id);
    this.compositeAborted.push(id);
    this.aborted.push({ id, reason });
    return { origin: TEST_ORIGIN, toolAudit: null };
  }
  async rollbackComposite(id: JournalId, reason: ErrorCode) {
    return this.abortComposite(id, reason);
  }
  async resolveOrphanedRestore() {}
  async resolveOrphanedAccept(): Promise<WriteEnvelope> { throw new Error("unused"); }
  async orphanComposite(id: JournalId) {
    if (this.compositeOrphanError) throw this.compositeOrphanError;
    this.compositePending.delete(id);
    this.compositeOrphaned.push(id);
  }
  async readSteps() { return []; }
  async readBackupRevisionSteps() { return []; }
  async readPendingComposite() { return null; }
  async listPendingComposites() { return []; }
  async isJournalOwned() { return false; }
  async readProjectRecoveryStatus() {
    return this.recoveryRequired
      ? { writeStatus: "recovery_required" as const, unresolved: [{ journalId: 1 as JournalId, status: "pending" as const }] }
      : { writeStatus: "ready" as const, unresolved: [] };
  }
  async assertProjectWritable() {
    this.gateChecks += 1;
    if (this.recoveryRequired) throw new Error("recovery required");
  }
}

class FakeBackups {
  readonly creates: Array<{ projectId: ProjectId; reason: string; files: BackupSource[] }> = [];
  verified = true;
  createError: Error | null = null;

  async create(projectId: ProjectId, reason: string, files: BackupSource[]): Promise<BackupManifest> {
    if (this.createError) throw this.createError;
    this.creates.push({ projectId, reason, files });
    return {
      id: "backup-1",
      projectId,
      revisionId: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      reason,
      entries: [],
      manifestHash: digest("manifest"),
      payloadPrunedAt: null,
    };
  }
  async read() { return null; }
  async readPayloads() { return []; }
  async verify() { return this.verified; }
  async list() { return []; }
  async prunePayloads() { return 0; }
  async cleanupOrphanPayloads() { return 0; }
}

class FakeUndoContent implements UndoContentPort {
  readonly byteStorages: Array<"inline" | "object"> = [];
  readonly fileSources: StagedFileSource[] = [];
  readonly released: UndoContentRef[][] = [];
  failAfter = Number.POSITIVE_INFINITY;
  private calls = 0;

  async retainBytes(bytes: Uint8Array, encoding: "utf8" | "binary", storage: "inline" | "object") {
    this.calls += 1;
    if (this.calls > this.failAfter) throw new Error("injected retain failure");
    this.byteStorages.push(storage);
    return storage === "inline"
      ? { kind: "inline" as const, bytes: new Uint8Array(bytes), encoding, contentHash: digest(bytes) }
      : { kind: "object" as const, encoding, contentHash: digest(bytes) };
  }
  async retainFile(source: StagedFileSource, encoding: "utf8" | "binary") {
    this.calls += 1;
    if (this.calls > this.failAfter) throw new Error("injected retain failure");
    this.fileSources.push(source);
    return { kind: "object" as const, encoding, contentHash: source.contentHash };
  }
  async resolve(ref: UndoContentRef): Promise<Uint8Array | StagedFileSource> {
    void ref;
    throw new Error("unused");
  }
  release(refs: readonly UndoContentRef[]) { this.released.push([...refs]); }
}

class FakeMutationObserver implements MutationObserverPort {
  claimResult: { ok: true } | { ok: false; reason: string } = { ok: true };
  claims = 0;
  aborts = 0;
  readonly receipts: MutationReceipt[] = [];
  readonly blocks: Array<{ projectId: ProjectId; origin: MutationReceipt["origin"]; paths: RelPath[] }> = [];
  invalidations = 0;
  emitResult: { ok: true } | { ok: false; reason: string } = { ok: true };
  throwOnEmit = false;
  onEmit: (() => void) | null = null;
  claimHistoryOperation() { this.claims += 1; return this.claimResult; }
  abortHistoryOperation() { this.aborts += 1; }
  blockHistoryOperation(blockedProjectId: ProjectId, origin: MutationReceipt["origin"], paths: RelPath[]) {
    this.blocks.push({ projectId: blockedProjectId, origin, paths });
  }
  emit(receipt: MutationReceipt) {
    this.onEmit?.();
    if (this.throwOnEmit) throw new Error("injected observer failure");
    this.receipts.push(receipt);
    return this.emitResult;
  }
  observeExternalChange() {}
  invalidateProject() { this.invalidations += 1; }
}

function setup(overrides: {
  undoContent?: UndoContentPort;
  observer?: MutationObserverPort;
  writtenStates?: WrittenStateTrackerPort;
  stagedAssets?: StagedAssetPort;
  pendingMount?: PendingMountPort;
} = {}) {
  const workspace = new FakeWorkspace();
  const journal = new FakeJournal();
  const lease = { held: true };
  const backups = new FakeBackups();
  const reconciliation: { calls: JournalId[]; outcome: CompositeReconcileOutcome | null } = {
    calls: [],
    outcome: null,
  };
  const authority = new WriteAuthority({
    workspace,
    journal,
    compositeJournal: journal,
    lease: {
      async acquire() { return { ok: true as const, leaseId: "lease" }; },
      async renew() { return lease.held; },
      async release() {},
      async assertHeld() { return lease.held; },
    },
    leaseId: "lease",
    hashContent: digest,
    invalidate() {},
    notifyEvents() {},
    backups,
    stagedAssets: overrides.stagedAssets,
    pendingMount: overrides.pendingMount,
    undoContent: overrides.undoContent,
    observer: overrides.observer,
    writtenStates: overrides.writtenStates,
    clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
    async reconcileJournal(id) {
      reconciliation.calls.push(id);
      return reconciliation.outcome
        ? { ok: true as const, value: reconciliation.outcome }
        : { ok: false as const, error: { code: ErrorCode.RecoveryRequired, message: "still pending" } };
    },
  });
  return { authority, workspace, journal, lease, backups, reconciliation };
}

describe("WriteAuthority composite gate", () => {
  it("arms path states before publish and settles commit versus rollback", async () => {
    for (const publishFails of [false, true]) {
      const order: string[] = [];
      const tracker: WrittenStateTrackerPort = {
        arm(_projectId, _journalId, states) {
          order.push(`arm:${states[0]?.before.kind}->${states[0]?.after.kind}`);
        },
        settle(_journalId, outcome) { order.push(`settle:${outcome}`); },
      };
      const { authority, workspace } = setup({ writtenStates: tracker });
      workspace.writeFailure = () => {
        order.push("publish");
        return publishFails;
      };
      const result = await authority.mutateSource({
        ref: project,
        steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: null }],
        origin: TEST_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "agent");
      expect(result.ok).toBe(!publishFails);
      expect(order).toEqual([
        "arm:absent->file",
        "publish",
        `settle:${publishFails ? "rolled_back" : "committed"}`,
      ]);
    }
  });

  it("uses the Core-owned write-staged undoable flag to retain or omit content", async () => {
    for (const undoable of [false, true]) {
      const active: { workspace: FakeWorkspace | null } = { workspace: null };
      const observer = new FakeMutationObserver();
      const undoContent = new FakeUndoContent();
      const stagedAssets: StagedAssetPort = {
        async stage() { throw new Error("unused byte staging"); },
        async stageFile(target, targetPath, _sourcePath, expectedHash) {
          return {
            temporaryPath: "/app/staged.tmp",
            targetPath,
            contentHash: expectedHash,
            async commit() { active.workspace!.files.set(target, "next"); },
            async cleanup() { active.workspace!.files.delete(target); },
          };
        },
      };
      const setupResult = setup({ observer, undoContent, stagedAssets });
      active.workspace = setupResult.workspace;
      active.workspace.directories.add("assets");
      if (undoable) active.workspace.files.set("assets/item.bin", "old");

      const result = await setupResult.authority.mutateSource({
        ref: project,
        steps: [{
          kind: "write-staged",
          path: "assets/item.bin" as RelPath,
          source: { sourcePath: "/app/source.bin" as AbsolutePath, contentHash: digest("next") },
          expectedContentHash: undoable ? digest("old") : null,
          undoable,
        }],
        origin: RECORD_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "agent");

      expect(result.ok, result.ok ? "" : JSON.stringify(result.error)).toBe(true);
      if (!result.ok) continue;
      expect(observer.receipts[0]?.steps[0]).toMatchObject({ kind: "file", undoable });
      expect(undoContent.fileSources).toHaveLength(undoable ? 2 : 0);
      expect(undoContent.byteStorages).toHaveLength(0);
    }
  });

  it("rejects a staged source hidden inside an ordinary authored write", async () => {
    const { authority, workspace, journal } = setup();
    workspace.directories.add("assets");
    const result = await authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write",
        path: "assets/item.bin" as RelPath,
        content: { sourcePath: "/app/source.bin" as AbsolutePath, contentHash: digest("next") },
        expectedContentHash: null,
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid } });
    expect(journal.compositeContextHistory).toEqual([]);

    workspace.files.set("assets/existing.bin", "old");
    await expect(authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write-staged",
        path: "assets/existing.bin" as RelPath,
        source: { sourcePath: "/app/source.bin" as AbsolutePath, contentHash: digest("next") },
        expectedContentHash: digest("old"),
        undoable: false,
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid } });
    expect(journal.compositeContextHistory).toEqual([]);
  });

  it("binds a pending mount open to the exact staged path and hash before T1", async () => {
    const operationId = "01K00000000000000000000000";
    const source = { sourcePath: "/app/source.bin" as AbsolutePath, contentHash: digest("asset") };
    let active: FakeWorkspace | null = null;
    const stagedAssets: StagedAssetPort = {
      async stage() { throw new Error("unused"); },
      async stageFile(target, targetPath, _sourcePath, expectedHash) {
        return {
          temporaryPath: "/app/staged.tmp",
          targetPath,
          contentHash: expectedHash,
          async commit() { active!.files.set(target, "asset"); },
          async cleanup() { active!.files.delete(target); },
        };
      },
    };
    const pendingMount: PendingMountPort = {
      async lookup() { return { state: "never-seen" as const }; },
      async listPending() { return []; },
      async markFailed() {},
      async abandon() {},
    };
    const setupResult = setup({ stagedAssets, pendingMount });
    active = setupResult.workspace;
    active.directories.add("assets");
    const transition: PendingMountTransition = {
      kind: "open",
      operationId,
      record: {
        operationId,
        projectId,
        assetPath: "assets/item.bin" as RelPath,
        assetContentHash: source.contentHash,
        uploadFingerprint: digest("upload-request"),
        atSeconds: 2,
        trackIndex: 0,
      },
    };
    await expect(setupResult.authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write-staged",
        path: "assets/item.bin" as RelPath,
        source,
        expectedContentHash: null,
        undoable: false,
      }],
      pendingMountTransition: transition,
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: true });
    expect(setupResult.journal.pendingMountTransitions).toEqual([transition]);

    const invalid = { ...transition, record: { ...transition.record, assetContentHash: digest("other") } };
    await expect(setupResult.authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write-staged",
        path: "assets/other.bin" as RelPath,
        source,
        expectedContentHash: null,
        undoable: false,
      }],
      pendingMountTransition: invalid,
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid } });
    expect(setupResult.journal.pendingMountTransitions).toEqual([transition]);
  });

  it("rechecks close state and permits reopen only from a matching undo inverse", async () => {
    const operationId = "01K00000000000000000000000";
    const failure = { code: "probe_failed", message: "Could not inspect media" };
    const record: PendingMount = {
      operationId,
      projectId,
      assetPath: "assets/item.bin" as RelPath,
      assetContentHash: digest("asset"),
      uploadFingerprint: digest("request"),
      atSeconds: 1,
      trackIndex: 0,
      state: "uploaded_unmounted",
      lastFailure: failure,
      mountedSceneId: null,
      mountedRevision: null,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    const pendingMount: PendingMountPort = {
      async lookup() { return { state: "active" as const, record }; },
      async listPending() { return []; },
      async markFailed() {},
      async abandon() {},
    };
    const observer = new FakeMutationObserver();
    const setupResult = setup({ pendingMount, observer });
    const close: PendingMountTransition = { kind: "close", operationId, sceneId: "scene-1", previousFailure: failure };
    await expect(setupResult.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "close", expectedContentHash: null }],
      pendingMountTransition: close,
      origin: RECORD_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: true });
    expect(setupResult.journal.pendingMountTransitions).toEqual([close]);
    expect(observer.receipts[0]?.steps).toContainEqual({
      kind: "pending-mount",
      undoable: true,
      operationId,
      before: { state: "uploaded_unmounted", lastFailure: failure },
      after: { state: "mounted", sceneId: "scene-1", revision: 1 },
    });

    record.state = "mounted";
    record.lastFailure = null;
    record.mountedSceneId = "scene-1";
    record.mountedRevision = 1;
    const reopen: PendingMountTransition = {
      kind: "reopen",
      operationId,
      expectedSceneId: "scene-1",
      restoreFailure: failure,
    };
    await expect(setupResult.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "reopen", expectedContentHash: digest("close") }],
      pendingMountTransition: reopen,
      origin: {
        kind: "ui",
        sessionId: "session-1",
        label: "Undo mount",
        historyAction: "undo",
        historyOperation: { id: "history-op", targetReceiptId: "journal:1" },
      },
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({ ok: true });
    expect(setupResult.journal.pendingMountTransitions).toEqual([close, reopen]);
  });

  it("validates mkdir absent/either collisions and records an existing-directory guard", async () => {
    const observer = new FakeMutationObserver();
    const { authority, workspace, journal } = setup({ observer });
    workspace.directories.add("assets");

    await expect(authority.mutateSource({
      ref: project,
      steps: [{ kind: "mkdir", path: "assets" as RelPath, expectExisting: "absent" }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(journal.compositeContextHistory).toHaveLength(0);

    workspace.directories.delete("assets");
    for (const collision of ["file", "symlink"] as const) {
      if (collision === "file") workspace.files.set("assets", "collision");
      else workspace.specialKinds.set("assets", "symlink");
      await expect(authority.mutateSource({
        ref: project,
        steps: [{ kind: "mkdir", path: "assets" as RelPath, expectExisting: "either" }],
        origin: TEST_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
      workspace.files.delete("assets");
      workspace.specialKinds.delete("assets");
      expect(journal.compositeContextHistory).toHaveLength(0);
    }

    workspace.directories.add("assets");
    const result = await authority.mutateSource({
      ref: project,
      steps: [
        { kind: "mkdir", path: "assets" as RelPath, expectExisting: "either" },
        { kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: null },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(result).toMatchObject({ ok: true });
    expect(observer.receipts[0]?.readGuards).toEqual([
      { path: "assets", state: { kind: "directory" } },
    ]);
  });

  it("validates rmdir against the snapshot and only preceding planned removals", async () => {
    const valid = setup();
    valid.workspace.directories.add("assets");
    valid.workspace.directories.add("assets/sub");
    valid.workspace.files.set("assets/sub/a.txt", "a");
    valid.workspace.directoryEntries.set("assets/sub", [{ name: "a.txt", kind: "file" }]);
    valid.workspace.directoryEntries.set("assets", [{ name: "sub", kind: "directory" }]);
    await valid.authority.mutateSource({
      ref: project,
      steps: [
        { kind: "delete", path: "assets/sub/a.txt" as RelPath, expectedContentHash: digest("a") },
        { kind: "rmdir", path: "assets/sub" as RelPath, expectEmpty: true },
        { kind: "rmdir", path: "assets" as RelPath, expectEmpty: true },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(valid.journal.compositeContextHistory).toHaveLength(1);

    for (const [steps, expectedCode] of [
      [
        [
          { kind: "rmdir" as const, path: "assets" as RelPath, expectEmpty: true as const },
          { kind: "delete" as const, path: "assets/a.txt" as RelPath, expectedContentHash: digest("a") },
        ],
        ErrorCode.SchemaInvalid,
      ],
      [
        [{ kind: "rmdir" as const, path: "assets" as RelPath, expectEmpty: true as const }],
        ErrorCode.WriteConflict,
      ],
    ] as const) {
      const blocked = setup();
      blocked.workspace.directories.add("assets");
      blocked.workspace.files.set("assets/a.txt", "a");
      blocked.workspace.directoryEntries.set("assets", [{ name: "a.txt", kind: "file" }]);
      await expect(blocked.authority.mutateSource({
        ref: project,
        steps: [...steps],
        origin: TEST_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "agent")).resolves.toMatchObject({ ok: false, error: { code: expectedCode } });
      expect(blocked.journal.compositeContextHistory).toHaveLength(0);
    }
  });

  it("rejects directory step order before opening T1", async () => {
    for (const steps of [
      [
        { kind: "mkdir" as const, path: "assets/child" as RelPath, expectExisting: "absent" as const },
        { kind: "mkdir" as const, path: "assets" as RelPath, expectExisting: "absent" as const },
      ],
      [
        { kind: "rmdir" as const, path: "assets" as RelPath, expectEmpty: true as const },
        { kind: "rmdir" as const, path: "assets/child" as RelPath, expectEmpty: true as const },
      ],
    ]) {
      const { authority, journal } = setup();
      await expect(authority.mutateSource({
        ref: project,
        steps,
        origin: TEST_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.SchemaInvalid } });
      expect(journal.compositeContextHistory).toHaveLength(0);
    }
  });

  it("preserves external directory races and escalates an unowned post-capture mkdir", async () => {
    const create = setup();
    create.workspace.beforeDirectoryPublish = (capture, action) => {
      expect(action).toBe("mkdir");
      create.workspace.directories.add(capture.target);
    };
    await expect(create.authority.mutateSource({
      ref: project,
      steps: [{ kind: "mkdir", path: "assets" as RelPath, expectExisting: "absent" }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.RecoveryRequired } });
    expect(create.workspace.directories.has("assets")).toBe(true);

    const remove = setup();
    remove.workspace.directories.add("assets");
    remove.workspace.beforeDirectoryPublish = (capture, action) => {
      expect(action).toBe("rmdir");
      remove.workspace.directoryEntries.set(capture.target, [{ name: "external.txt", kind: "file" }]);
    };
    await expect(remove.authority.mutateSource({
      ref: project,
      steps: [{ kind: "rmdir", path: "assets" as RelPath, expectEmpty: true }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(remove.workspace.directories.has("assets")).toBe(true);
    expect(remove.workspace.directoryEntries.get("assets")).toEqual([{ name: "external.txt", kind: "file" }]);
  });

  it("records and orphans a capture whose local restore is blocked by a replacement", async () => {
    const { authority, journal, workspace } = setup();
    workspace.files.set("index.html", "original");
    workspace.captureRecovery = true;

    await expect(authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "new",
        expectedContentHash: digest("original"),
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.RecoveryRequired,
        details: { phase: "capture_restore_blocked", captures: 1 },
      },
    });

    expect(workspace.files.get("index.html")).toBe("external replacement");
    expect([...workspace.captures.values()]).toEqual(["original"]);
    expect(journal.capturedSteps).toEqual([{
      id: 1,
      ordinal: 0,
      rollbackPath: "index.html.rollback-1-0",
    }]);
    expect(journal.compositeOrphaned).toEqual([1]);
  });

  it("checks lease and recovery state under the project mutex before T1 or filesystem I/O", async () => {
    const { authority, journal, workspace } = setup();
    journal.recoveryRequired = true;
    await expect(authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "new",
        expectedContentHash: digest("old"),
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.RecoveryRequired },
    });
    expect(journal.gateChecks).toBe(1);
    expect(journal.pending).toEqual([]);
    expect(workspace.writes).toBe(0);
  });

  it("rejects duplicate canonical targets before beginning a journal", async () => {
    const { authority, journal, workspace } = setup();
    workspace.resolvedPaths.set("alias.html", "index.html");
    await expect(authority.mutateSource({
      ref: project,
      steps: [
        { kind: "write", path: "index.html" as RelPath, content: "one", expectedContentHash: null },
        { kind: "delete", path: "alias.html" as RelPath, expectedContentHash: digest("old") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.DuplicateMutationTarget },
    });
    expect(journal.pending).toEqual([]);
    expect(workspace.writes).toBe(0);
  });

  it("validates every precondition before T1 and leaves all targets untouched on a late conflict", async () => {
    const { authority, journal, workspace } = setup();
    workspace.files.set("one.html", "one-old");
    workspace.files.set("two.html", "two-current");
    await expect(authority.mutateSource({
      ref: project,
      steps: [
        { kind: "write", path: "one.html" as RelPath, content: "one-new", expectedContentHash: digest("one-old") },
        { kind: "write", path: "two.html" as RelPath, content: "two-new", expectedContentHash: digest("two-stale") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.WriteConflict },
    });
    expect(journal.pending).toEqual([]);
    expect(workspace.writes).toBe(0);
    expect(workspace.files.get("one.html")).toBe("one-old");
  });

  it("rejects a purpose-mismatched target before T1", async () => {
    const { authority, journal, workspace } = setup();
    workspace.rejectedPaths.add("preview-settings.json");
    await expect(authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write",
        path: "preview-settings.json" as RelPath,
        content: "{}",
        expectedContentHash: null,
      }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.AssetNotAllowed },
    });
    expect(journal.compositePending.size).toBe(0);
    expect(workspace.writes).toBe(0);
  });

  it("merges file history read guards into grant observed hashes", async () => {
    const { authority, journal, workspace } = setup();
    workspace.files.set("index.html", "entry-old");
    workspace.files.set("assets/shared/font.woff2", "font-v1");
    const base = {
      ref: project,
      steps: [{
        kind: "write" as const,
        path: "index.html" as RelPath,
        content: "entry-new",
        expectedContentHash: digest("entry-old"),
      }],
      origin: TEST_ORIGIN,
      historyReadGuards: [{
        path: "assets/shared/font.woff2" as RelPath,
        state: { kind: "file" as const, contentHash: digest("font-v1") },
      }],
      toolAudit: null,
      backup: false,
    };

    await expect(authority.mutateSource({
      ...base,
      grant: {
        id: "grant-missing-guard",
        binding: {
          tool: "test_history_guard",
          projectId,
          target: "index.html",
          expectedRevision: 0,
          planDigest: "plan-history-guard",
          targetHashes: { ["index.html" as RelPath]: digest("entry-old") },
        },
      },
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.ApprovalInvalid },
    });
    expect(journal.compositePending.size).toBe(0);

    await expect(authority.mutateSource({
      ...base,
      grant: {
        id: "grant-complete",
        binding: {
          tool: "test_history_guard",
          projectId,
          target: "index.html",
          expectedRevision: 0,
          planDigest: "plan-history-guard",
          targetHashes: {
            ["index.html" as RelPath]: digest("entry-old"),
            ["assets/shared/font.woff2" as RelPath]: digest("font-v1"),
          },
        },
      },
    }, "agent")).resolves.toMatchObject({ ok: true });
  });

  it("synchronously blocks an inverse reservation when step or read-guard preconditions diverge", async () => {
    const inverseOrigin = {
      kind: "ui",
      sessionId: "01K1ABCDEFGHJKMNPQRSTVWXYZ",
      label: "Undo edit",
      historyAction: "undo",
      historyOperation: { id: "operation-1", targetReceiptId: "journal:previous" },
    } as const;

    const stepObserver = new FakeMutationObserver();
    const step = setup({ observer: stepObserver });
    step.workspace.files.set("index.html", "current");
    await expect(step.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "restored", expectedContentHash: digest("stale") }],
      origin: inverseOrigin,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.WriteConflict, details: { blockedBy: ["index.html"] } },
    });
    expect(stepObserver.blocks).toEqual([{ projectId, origin: inverseOrigin, paths: ["index.html"] }]);

    const guardObserver = new FakeMutationObserver();
    const guard = setup({ observer: guardObserver });
    guard.workspace.files.set("index.html", "current");
    guard.workspace.files.set("assets/shared.png", "changed");
    await expect(guard.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "restored", expectedContentHash: digest("current") }],
      historyReadGuards: [{
        path: "assets/shared.png" as RelPath,
        state: { kind: "file", contentHash: digest("expected") },
      }],
      origin: inverseOrigin,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.WriteConflict, details: { blockedBy: ["assets/shared.png"] } },
    });
    expect(guardObserver.blocks).toEqual([{ projectId, origin: inverseOrigin, paths: ["assets/shared.png"] }]);

    const entityObserver = new FakeMutationObserver();
    const entity = setup({ observer: entityObserver });
    const entityContent = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
    entity.workspace.files.set("preview-settings.json", entityContent);
    entity.journal.entityState = {
      revision: 12,
      contentHash: digest(entityContent),
      backingPath: "preview-settings.json" as RelPath,
    };
    await expect(entity.authority.mutateSource({
      ref: project,
      steps: [{
        kind: "entity",
        entity: "preview-settings",
        patch: { bgm: { volume: 0.5 } },
        expectedRevision: 12,
        expectedContentHash: digest("wrong-direction"),
        undoable: true,
      }],
      origin: inverseOrigin,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.WriteConflict,
        details: { blockedBy: ["preview-settings.json"] },
      },
    });
    expect(entityObserver.blocks).toEqual([{
      projectId,
      origin: inverseOrigin,
      paths: ["preview-settings.json"],
    }]);
  });

  it("returns the exact inverse receipt already delivered to the observer", async () => {
    const content = new FakeUndoContent();
    const observer = new FakeMutationObserver();
    const runtime = setup({ undoContent: content, observer });
    runtime.workspace.files.set("index.html", "before-undo");
    const inverseOrigin = {
      kind: "ui",
      sessionId: "01K1ABCDEFGHJKMNPQRSTVWXYZ",
      label: "Undo edit",
      historyAction: "undo",
      historyOperation: { id: "operation-return", targetReceiptId: "journal:prior" },
    } as const;

    const result = await runtime.authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "after-undo",
        expectedContentHash: digest("before-undo"),
      }],
      origin: inverseOrigin,
      toolAudit: null,
      backup: false,
    }, "user");

    expect(result).toMatchObject({
      ok: true,
      value: { inverseReceipt: { origin: inverseOrigin, paths: ["index.html"] } },
    });
    expect(result.ok && result.value.inverseReceipt).toBe(observer.receipts[0]);
  });

  it("caps retained inline content at 64 KiB per ref and 256 KiB per mutation", async () => {
    const content = new FakeUndoContent();
    const observer = new FakeMutationObserver();
    const { authority, workspace } = setup({ undoContent: content, observer });
    const old = ["a", "b", "c"].map((value) => value.repeat(50 * 1024));
    const next = ["d", "e", "f"].map((value) => value.repeat(50 * 1024));
    const paths = ["one.html", "two.html", "three.html"] as const;
    paths.forEach((path, index) => workspace.files.set(path, old[index]!));

    await expect(authority.mutateSource({
      ref: project,
      steps: paths.map((path, index) => ({
        kind: "write" as const,
        path: path as RelPath,
        content: next[index]!,
        expectedContentHash: digest(old[index]!),
      })),
      origin: RECORD_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({ ok: true });

    expect(content.byteStorages).toEqual(["inline", "inline", "inline", "inline", "inline", "object"]);
    expect(content.fileSources).toEqual([]);
    expect(content.released).toEqual([]);
    expect(observer.receipts).toHaveLength(1);
    expect(observer.receipts[0]).toMatchObject({ id: "journal:1", undoable: true });
  });

  it("does not retain undo ownership for an origin that explicitly ignores history", async () => {
    const content = new FakeUndoContent();
    const observer = new FakeMutationObserver();
    const runtime = setup({ undoContent: content, observer });
    runtime.workspace.files.set("index.html", "old");

    await expect(runtime.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: true });

    expect(content.byteStorages).toEqual([]);
    expect(content.fileSources).toEqual([]);
    expect(content.released).toEqual([]);
    expect(observer.receipts[0]).toMatchObject({ undoable: false });
  });

  it("bounds inline ownership for 1,024-file and 50-receipt history loads", async () => {
    const inlineBytes = (receipt: MutationReceipt) => receipt.steps.reduce((total, step) => {
      if (step.kind !== "file" || !step.undoable) return total;
      return total
        + (step.beforeContent?.kind === "inline" ? step.beforeContent.bytes.byteLength : 0)
        + (step.afterContent?.kind === "inline" ? step.afterContent.bytes.byteLength : 0);
    }, 0);

    const bulkContent = new FakeUndoContent();
    const bulkObserver = new FakeMutationObserver();
    const bulk = setup({ undoContent: bulkContent, observer: bulkObserver });
    const before = "a".repeat(512);
    const after = "b".repeat(512);
    const bulkSteps = Array.from({ length: 1_024 }, (_, index) => {
      const path = `compositions/bulk-${index}.html` as RelPath;
      bulk.workspace.files.set(path, before);
      return { kind: "write" as const, path, content: after, expectedContentHash: digest(before) };
    });
    await expect(bulk.authority.mutateSource({
      ref: project,
      steps: bulkSteps,
      origin: RECORD_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({ ok: true });
    expect(bulkObserver.receipts[0]?.steps).toHaveLength(1_024);
    expect(inlineBytes(bulkObserver.receipts[0]!)).toBeLessThanOrEqual(256 * 1_024);
    expect(bulkContent.byteStorages).toContain("object");

    const rollingContent = new FakeUndoContent();
    const rollingObserver = new FakeMutationObserver();
    const rolling = setup({ undoContent: rollingContent, observer: rollingObserver });
    const paths = Array.from({ length: 3 }, (_, index) => `compositions/rolling-${index}.html` as RelPath);
    let current = "c".repeat(50 * 1_024);
    for (const path of paths) rolling.workspace.files.set(path, current);
    for (let index = 0; index < 50; index += 1) {
      const next = String.fromCharCode(100 + (index % 20)).repeat(50 * 1_024);
      await expect(rolling.authority.mutateSource({
        ref: project,
        steps: paths.map((path) => ({
          kind: "write" as const,
          path,
          content: next,
          expectedContentHash: digest(current),
        })),
        origin: RECORD_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "user")).resolves.toMatchObject({ ok: true });
      current = next;
    }
    expect(rollingObserver.receipts).toHaveLength(50);
    expect(rollingObserver.receipts.reduce((total, receipt) => total + inlineBytes(receipt), 0))
      .toBeLessThanOrEqual(12.5 * 1_024 * 1_024);
  }, 20_000);

  it("streams large captured before-content and aborts before publish when retention fails", async () => {
    const content = new FakeUndoContent();
    const { authority, workspace, journal } = setup({ undoContent: content });
    const old = "a".repeat(70 * 1024);
    workspace.files.set("index.html", old);
    content.failAfter = 1;

    await expect(authority.mutateSource({
      ref: project,
      steps: [{
        kind: "write",
        path: "index.html" as RelPath,
        content: "b".repeat(70 * 1024),
        expectedContentHash: digest(old),
      }],
      origin: RECORD_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.StorageUnavailable },
    });

    expect(content.fileSources).toHaveLength(1);
    expect(content.released[0]).toHaveLength(1);
    expect(workspace.files.get("index.html")).toBe(old);
    expect(workspace.writes).toBe(0);
    expect(journal.compositePending.size).toBe(0);
  });

  it("claims undo immediately before publish and releases refs on claim or publish failure", async () => {
    const undoOrigin = {
      kind: "ui" as const,
      sessionId: "01K2TESTSESSION000000000000",
      label: "Undo edit",
      historyAction: "undo" as const,
      historyOperation: { id: "operation-1", targetReceiptId: "journal:1" },
    };
    const rejectedContent = new FakeUndoContent();
    const rejectedObserver = new FakeMutationObserver();
    rejectedObserver.claimResult = { ok: false, reason: "stale reservation" };
    const rejected = setup({ undoContent: rejectedContent, observer: rejectedObserver });
    rejected.workspace.files.set("index.html", "old");
    await expect(rejected.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      origin: undoOrigin,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(rejectedObserver.claims).toBe(1);
    expect(rejectedObserver.aborts).toBe(0);
    expect(rejectedContent.released).toHaveLength(1);
    expect(rejected.workspace.files.get("index.html")).toBe("old");

    const failedContent = new FakeUndoContent();
    const failedObserver = new FakeMutationObserver();
    const failed = setup({ undoContent: failedContent, observer: failedObserver });
    failed.workspace.files.set("index.html", "old");
    let failPublish = true;
    failed.workspace.writeFailure = () => {
      if (!failPublish) return false;
      failPublish = false;
      return true;
    };
    await expect(failed.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      origin: undoOrigin,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.StorageUnavailable } });
    expect(failedObserver.claims).toBe(1);
    expect(failedObserver.aborts).toBe(1);
    expect(failedContent.released).toHaveLength(1);
    expect(failed.workspace.files.get("index.html")).toBe("old");
  });

  it("emits after commit before capture discard and degrades observer failure to a warning", async () => {
    const content = new FakeUndoContent();
    const observer = new FakeMutationObserver();
    observer.throwOnEmit = true;
    const runtime = setup({ undoContent: content, observer });
    runtime.workspace.files.set("index.html", "old");
    observer.onEmit = () => expect(runtime.workspace.captures.size).toBe(1);

    await expect(runtime.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      origin: RECORD_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({
      ok: true,
      value: {
        diagnostics: [{ severity: "warning", code: "history-unavailable" }],
      },
    });
    expect(runtime.workspace.files.get("index.html")).toBe("new");
    expect(runtime.workspace.captures.size).toBe(0);
    expect(content.released).toHaveLength(1);
    expect(observer.invalidations).toBe(1);
  });

  it("does not reconcile or emit twice when capture discard fails after commit", async () => {
    const observer = new FakeMutationObserver();
    const runtime = setup({ observer });
    runtime.workspace.files.set("index.html", "old");
    runtime.workspace.discardFailures = 1;

    await expect(runtime.authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      origin: RECORD_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "user")).resolves.toMatchObject({
      ok: true,
      value: {
        projectRevision: 1,
        diagnostics: [{ severity: "warning", code: "capture-cleanup-unavailable" }],
      },
    });
    expect(runtime.workspace.files.get("index.html")).toBe("new");
    expect(runtime.workspace.discardAttempts).toBe(1);
    expect(runtime.workspace.captures.size).toBe(1);
    expect(observer.receipts).toHaveLength(1);
    expect(runtime.reconciliation.calls).toEqual([]);
  });

  it("keeps standalone entity receipts non-undoable and accepts only Core-authored undoable policy", async () => {
    const run = async (undoable: boolean | undefined) => {
      const observer = new FakeMutationObserver();
      const runtime = setup({ observer });
      const current = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
      runtime.workspace.files.set("preview-settings.json", current);
      runtime.journal.entityState = {
        revision: 0,
        contentHash: digest(current),
        backingPath: "preview-settings.json" as RelPath,
      };
      const result = await runtime.authority.mutateSource({
        ref: project,
        steps: [{
          kind: "entity",
          entity: "preview-settings",
          patch: { tone: { enabled: true } },
          expectedRevision: 0,
          ...(undoable === undefined ? {} : { undoable }),
        }],
        origin: RECORD_ORIGIN,
        toolAudit: null,
        backup: false,
      }, "user");
      expect(result).toMatchObject({ ok: true });
      return observer.receipts[0]!;
    };

    expect(await run(undefined)).toMatchObject({ undoable: false, steps: [{ kind: "entity", undoable: false }] });
    expect(await run(true)).toMatchObject({ undoable: true, steps: [{ kind: "entity", undoable: true }] });
  });

  it("persists T1, verifies and attaches backup, then applies steps in order before T2", async () => {
    const { authority, backups, journal, workspace } = setup();
    workspace.files.set("index.html", "entry-old");
    workspace.files.set("compositions/scene.html", "scene-old");
    await expect(authority.mutateSource({
      ref: project,
      steps: [
        { kind: "write", path: "index.html" as RelPath, content: "entry-new", expectedContentHash: digest("entry-old") },
        { kind: "delete", path: "compositions/scene.html" as RelPath, expectedContentHash: digest("scene-old") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: true,
    }, "agent")).resolves.toMatchObject({
      ok: true,
      value: { projectRevision: 1, fileHashes: { "index.html": digest("entry-new") } },
    });
    expect(backups.creates[0]).toMatchObject({
      projectId,
      reason: "tool:composite",
      files: [{ path: "index.html" }, { path: "compositions/scene.html" }],
    });
    expect(journal.attachedBackups).toEqual([{ id: 1, backupId: "backup-1" }]);
    expect(journal.compositePending.size).toBe(0);
    expect(workspace.files.get("index.html")).toBe("entry-new");
    expect(workspace.files.has("compositions/scene.html")).toBe(false);
  });

  it("returns recovery_required when backup failure cannot prove the journal terminal", async () => {
    const { authority, backups, journal, reconciliation, workspace } = setup();
    workspace.files.set("index.html", "old");
    backups.createError = new Error("backup unavailable");
    journal.compositeAbortError = new Error("T2a unavailable");

    await expect(authority.mutateSource({
      ref: project,
      steps: [{ kind: "delete", path: "index.html" as RelPath, expectedContentHash: digest("old") }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: true,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.RecoveryRequired,
        details: { journalId: 1, phase: "backup-abort" },
      },
    });
    expect(reconciliation.calls).toEqual([1]);
    expect(journal.compositePending.has(1 as JournalId)).toBe(true);
    expect(workspace.files.get("index.html")).toBe("old");
  });

  it("returns backup_failed after inline reconciliation proves a failed backup aborted", async () => {
    const { authority, backups, journal, reconciliation, workspace } = setup();
    workspace.files.set("index.html", "old");
    backups.verified = false;
    journal.compositeAbortError = new Error("T2a unavailable");
    reconciliation.outcome = { terminal: "aborted" };

    await expect(authority.mutateSource({
      ref: project,
      steps: [{ kind: "delete", path: "index.html" as RelPath, expectedContentHash: digest("old") }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: true,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.BackupFailed },
    });
    expect(reconciliation.calls).toEqual([1]);
    expect(workspace.files.get("index.html")).toBe("old");
  });

  it("rolls landed steps back in reverse and aborts only after every original hash verifies", async () => {
    const { authority, journal, workspace } = setup();
    workspace.files.set("one.html", "one-old");
    workspace.files.set("two.html", "two-old");
    workspace.writeFailure = (path, content) => path === "two.html"
      && typeof content === "string" && content === "two-new";
    await expect(authority.mutateSource({
      ref: project,
      steps: [
        { kind: "write", path: "one.html" as RelPath, content: "one-new", expectedContentHash: digest("one-old") },
        { kind: "write", path: "two.html" as RelPath, content: "two-new", expectedContentHash: digest("two-old") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.StorageUnavailable } });
    expect(workspace.files.get("one.html")).toBe("one-old");
    expect(workspace.files.get("two.html")).toBe("two-old");
    expect(journal.compositeAborted).toEqual([1]);
    expect(journal.compositeOrphaned).toEqual([]);
  });

  it("orphans and gates recovery when reverse rollback or hash verification fails", async () => {
    const { authority, journal, workspace } = setup();
    workspace.files.set("one.html", "one-old");
    workspace.files.set("two.html", "two-old");
    workspace.writeFailure = (path, content) => {
      const text = typeof content === "string" ? content : new TextDecoder().decode(content);
      return (path === "two.html" && text === "two-new") || (path === "one.html" && text === "one-old");
    };
    await expect(authority.mutateSource({
      ref: project,
      steps: [
        { kind: "write", path: "one.html" as RelPath, content: "one-new", expectedContentHash: digest("one-old") },
        { kind: "write", path: "two.html" as RelPath, content: "two-new", expectedContentHash: digest("two-old") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.RecoveryRequired } });
    expect(workspace.files.get("one.html")).toBe("one-new");
    expect(journal.compositeOrphaned).toEqual([1]);
    expect(journal.compositeAborted).toEqual([]);
  });

  it("keeps all-landed bytes and returns the inline reconciled commit after T2b fails", async () => {
    const observer = new FakeMutationObserver();
    const content = new FakeUndoContent();
    const { authority, journal, reconciliation, workspace } = setup({ observer, undoContent: content });
    workspace.files.set("index.html", "old");
    journal.compositeCommitError = new Error("T2 unavailable");
    reconciliation.outcome = {
      terminal: "committed",
      envelope: {
        projectRevision: 7,
        entityRevision: null,
        fileHashes: { ["index.html" as RelPath]: digest("new") },
        diagnostics: [],
        changeSeq: 7,
      },
    };
    await expect(authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      origin: {
        kind: "ui",
        sessionId: "01K2TESTSESSION000000000000",
        label: "Edit source",
        historyAction: "record",
        historyOperation: null,
      },
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: true, value: { projectRevision: 7 } });
    expect(reconciliation.calls).toEqual([1]);
    expect(workspace.files.get("index.html")).toBe("new");
    expect(observer.receipts).toMatchObject([{
      id: "journal:1",
      projectRevision: 7,
      origin: { kind: "ui", historyAction: "record", label: "Edit source" },
    }]);
    expect(content.released).toEqual([]);
  });

  it("returns recovery_required after one failed inline reconcile without rolling all-landed bytes back", async () => {
    const { authority, journal, reconciliation, workspace } = setup();
    workspace.files.set("index.html", "old");
    journal.compositeCommitError = new Error("T2 unavailable");
    await expect(authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.RecoveryRequired } });
    expect(reconciliation.calls).toEqual([1]);
    expect(workspace.files.get("index.html")).toBe("new");
    expect(journal.compositePending.has(1 as JournalId)).toBe(true);
  });

  it("runs one inline reconcile when T2a abort fails after verified rollback", async () => {
    const { authority, journal, reconciliation, workspace } = setup();
    workspace.files.set("one.html", "one-old");
    workspace.files.set("two.html", "two-old");
    workspace.writeFailure = (path, content) => path === "two.html"
      && typeof content === "string" && content === "two-new";
    journal.compositeAbortError = new Error("T2a unavailable");
    reconciliation.outcome = { terminal: "aborted" };
    await expect(authority.mutateSource({
      ref: project,
      steps: [
        { kind: "write", path: "one.html" as RelPath, content: "one-new", expectedContentHash: digest("one-old") },
        { kind: "write", path: "two.html" as RelPath, content: "two-new", expectedContentHash: digest("two-old") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.StorageUnavailable } });
    expect(reconciliation.calls).toEqual([1]);
    expect(workspace.files.get("one.html")).toBe("one-old");
  });

  it("runs one inline reconcile when T2c orphaning itself fails", async () => {
    const { authority, journal, reconciliation, workspace } = setup();
    workspace.files.set("one.html", "one-old");
    workspace.files.set("two.html", "two-old");
    workspace.writeFailure = (path, content) => {
      const text = typeof content === "string" ? content : new TextDecoder().decode(content);
      return (path === "two.html" && text === "two-new") || (path === "one.html" && text === "one-old");
    };
    journal.compositeOrphanError = new Error("T2c unavailable");
    reconciliation.outcome = { terminal: "orphaned" };
    await authority.mutateSource({
      ref: project,
      steps: [
        { kind: "write", path: "one.html" as RelPath, content: "one-new", expectedContentHash: digest("one-old") },
        { kind: "write", path: "two.html" as RelPath, content: "two-new", expectedContentHash: digest("two-old") },
      ],
      origin: TEST_ORIGIN,
      toolAudit: null,
      backup: false,
    }, "agent");
    expect(reconciliation.calls).toEqual([1]);
  });
});

describe("WriteAuthority file mutations", () => {
  it("forwards the optional one-step invocation audit into durable T1 unchanged", async () => {
    const { authority, journal } = setup();
    const toolAudit = {
      schemaVersion: 1 as const,
      invocationId: "invocation-save",
      tool: "save_file",
      level: "write" as const,
      projectId,
      era: "modern" as const,
      protocolVersion: "2026-07-28",
      detail: { path: "new.html" },
      credentialId: null,
      invokedAt: "2026-08-02T00:00:00.000Z",
      revisionBefore: 0,
    };
    await expect(authority.mutateSource({
      kind: "file",
      ref: project,
      path: "new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    }, "agent", { origin: TEST_ORIGIN, toolAudit })).resolves.toMatchObject({ ok: true });
    expect(journal.compositeContextHistory).toEqual([{ toolAudit }]);
  });

  it("refuses mutation after lease loss while leaving reads untouched", async () => {
    const { authority, lease, workspace } = setup();
    workspace.files.set("index.html", "old");
    lease.held = false;
    await expect(
      authority.mutateSource({
        kind: "file",
        ref: project,
        path: "index.html" as RelPath,
        content: "new",
        expectedContentHash: digest("old"),
      }, "user"),
    ).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.WorkspaceLeaseLost } });
    expect((await workspace.readFile("index.html" as ResolvedPath))?.content).toBe("old");
    expect(workspace.writes).toBe(0);
  });

  it("rejects missing, legacy and malformed preconditions with distinct codes", async () => {
    const { authority, workspace } = setup();
    workspace.files.set("index.html", "old");
    for (const [expectedContentHash, code] of [
      [null, ErrorCode.PreconditionRequired],
      ["l1-2z", ErrorCode.VersionFormatLegacy],
      ["anything", ErrorCode.SchemaInvalid],
    ] as const) {
      await expect(authority.mutateSource({
        kind: "file",
        ref: project,
        path: "index.html" as RelPath,
        content: "new",
        expectedContentHash,
      }, "user")).resolves.toMatchObject({ ok: false, error: { code } });
    }
  });

  it("serializes concurrent writes so exactly one expected hash wins", async () => {
    const { authority, workspace } = setup();
    workspace.files.set("index.html", "old");
    workspace.writeDelayMs = 10;
    const request = (content: string) => authority.mutateSource({
      kind: "file" as const,
      ref: project,
      path: "index.html" as RelPath,
      content,
      expectedContentHash: digest("old"),
    }, "user");
    const results = await Promise.all([request("first"), request("second")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const failed = results.find((result) => !result.ok);
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.WriteConflict,
        details: { current: { content: "first", contentHash: digest("first"), revision: 1 } },
      },
    });
  });

  it("creates a missing file with null and makes identical content a no-op", async () => {
    const { authority, workspace } = setup();
    const request = {
      kind: "file" as const,
      ref: project,
      path: "compositions/new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    };
    await expect(authority.mutateSource(request, "user")).resolves.toMatchObject({ ok: true, value: { revision: 1 } });
    await expect(authority.mutateSource({ ...request, expectedContentHash: digest("new") }, "user")).resolves.toMatchObject({
      ok: true,
      value: { revision: 1 },
    });
    expect(workspace.writes).toBe(1);
  });

  it("tells the caller when nothing was written, because no journal owns that invocation", async () => {
    const { authority } = setup();
    const request = {
      kind: "file" as const,
      ref: project,
      path: "compositions/new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    };
    let unchanged = 0;
    const invocation = { origin: TEST_ORIGIN, toolAudit: null, noteUnchanged: () => { unchanged += 1; } };

    await authority.mutateSource(request, "user", invocation);
    expect(unchanged).toBe(0);
    await authority.mutateSource(
      { ...request, expectedContentHash: digest("new") },
      "user",
      invocation,
    );
    expect(unchanged).toBe(1);
  });

  it("normalizes a conflict revision to zero when no revision exists", async () => {
    const { authority, workspace } = setup();
    workspace.files.set("index.html", "current");

    await expect(authority.mutateSource({
      kind: "file",
      ref: project,
      path: "index.html" as RelPath,
      content: "next",
      expectedContentHash: digest("stale"),
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { details: { current: { revision: 0 } } },
    });
  });

  it("aborts the journal immediately when the atomic file write fails", async () => {
    const { authority, workspace, journal } = setup();
    workspace.writeError = new Error("disk unavailable");

    await expect(authority.mutateSource({
      kind: "file",
      ref: project,
      path: "compositions/new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.StorageUnavailable },
    });
    expect(journal.pending).toEqual([]);
    expect(journal.aborted).toEqual([{ id: 1, reason: ErrorCode.StorageUnavailable }]);
  });

  it("keeps the journal pending for recovery when commit fails after the file write", async () => {
    const { authority, journal, workspace } = setup();
    journal.commitError = new Error("database unavailable");

    await expect(authority.mutateSource({
      kind: "file",
      ref: project,
      path: "compositions/new.html" as RelPath,
      content: "new",
      expectedContentHash: null,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.StorageUnavailable },
    });
    expect(workspace.files.get("compositions/new.html")).toBe("new");
    expect(journal.pending).toHaveLength(1);
    expect(journal.aborted).toEqual([]);
  });
});

describe("WriteAuthority entity mutations", () => {
  it("reports missing entity state as an internal invariant failure", async () => {
    const { authority } = setup();

    await expect(authority.mutateSource({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 0,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.Internal },
    });
  });

  it("supports revision zero with no backing file and returns the updated entity", async () => {
    const { authority, journal } = setup();
    journal.entityState = {
      revision: 0,
      contentHash: digest(serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS)),
      backingPath: "preview-settings.json" as RelPath,
    };
    await expect(authority.mutateSource({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 0,
    }, "user")).resolves.toMatchObject({
      ok: true,
      value: { revision: 1, previewSettings: { bgm: { volume: 0.7 } } },
    });
  });

  it("conflicts on stale revision or backing-file hash and includes current merge data", async () => {
    const { authority, journal, workspace } = setup();
    const content = serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS);
    workspace.files.set("preview-settings.json", content);
    journal.entityState = {
      revision: 2,
      contentHash: digest("stale"),
      backingPath: "preview-settings.json" as RelPath,
    };
    await expect(authority.mutateSource({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 2,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.WriteConflict,
        details: { current: { revision: 2, contentHash: digest(content), previewSettings: DEFAULT_PREVIEW_SETTINGS } },
      },
    });
  });

  it("aborts the journal immediately when the entity backing write fails", async () => {
    const { authority, journal, workspace } = setup();
    journal.entityState = {
      revision: 0,
      contentHash: digest(serializePreviewSettings(DEFAULT_PREVIEW_SETTINGS)),
      backingPath: "preview-settings.json" as RelPath,
    };
    workspace.writeError = new Error("disk unavailable");

    await expect(authority.mutateSource({
      kind: "entity",
      ref: project,
      entity: "preview-settings",
      patch: { bgm: { volume: 0.7 } },
      expectedRevision: 0,
    }, "user")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.StorageUnavailable },
    });
    expect(journal.pending).toEqual([]);
    expect(journal.aborted).toEqual([{ id: 1, reason: ErrorCode.StorageUnavailable }]);
  });
});
