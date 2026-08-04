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
  type MutationCapture,
  type MutationResult,
  type PendingMutation,
  type PendingMutationContext,
  type ProjectRef,
  type ResolvedPath,
  type StepIntent,
  type WriteEnvelope,
} from "@vidcom/core";

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
  readonly captures = new Map<string, string | null>();
  writeDelayMs = 0;
  writeError: Error | null = null;
  writeFailure: ((path: ResolvedPath, content: string | Uint8Array) => boolean) | null = null;
  writes = 0;
  readonly resolvedPaths = new Map<string, string>();
  readonly rejectedPaths = new Set<string>();

  async resolve(_ref: ProjectRef, path: string) {
    if (this.rejectedPaths.has(path)) {
      return { ok: false as const, error: { reason: "not_allowed_for_purpose" as const } };
    }
    return { ok: true as const, value: (this.resolvedPaths.get(path) ?? path) as ResolvedPath };
  }
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
    expectedHash: ContentHash | null,
    journalId: JournalId,
    ordinal: number,
  ) {
    const current = this.files.get(target) ?? null;
    const actualHash = current === null ? null : digest(current);
    if (actualHash !== expectedHash) return { ok: false as const, error: { actualHash } };
    const rollbackPath = current === null
      ? null
      : `${target}.rollback-${journalId}-${ordinal}` as ResolvedPath;
    if (rollbackPath !== null) this.captures.set(rollbackPath, current);
    this.files.delete(target);
    return {
      ok: true as const,
      value: { journalId, ordinal, target, rollbackPath, capturedHash: actualHash },
    };
  }
  async publishCaptured(capture: MutationCapture, content: string | Uint8Array | null) {
    if (this.files.has(capture.target)) return false;
    if (content === null) return true;
    this.writes += 1;
    if (this.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    if (this.writeError) throw this.writeError;
    if (this.writeFailure?.(capture.target, content)) throw new Error("injected write failure");
    this.files.set(capture.target, typeof content === "string" ? content : new TextDecoder().decode(content));
    return true;
  }
  async restoreCaptured(capture: MutationCapture, landedHash: ContentHash | null) {
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
    if (capture.rollbackPath !== null) this.captures.delete(capture.rollbackPath);
  }
  async readTree() { return []; }
  async stat(path: ResolvedPath) {
    const content = this.files.get(path);
    return content === undefined ? null : { size: content.length, modifiedAt: new Date(0), kind: "file" as const };
  }
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
  readonly attachedBackups: Array<{ id: JournalId; backupId: string }> = [];
  readonly compositeAborted: JournalId[] = [];
  readonly compositeOrphaned: JournalId[] = [];

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
  async beginComposite(intent: CompositeIntent, steps: StepIntent[], context: PendingMutationContext): Promise<JournalId> {
    void intent;
    void context;
    const id = (this.compositePending.size + 1) as JournalId;
    this.compositePending.set(id, steps);
    this.compositeContextHistory.push(context);
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
  async markStepCaptured() {}
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
    return { projectRevision: this.revision, entityRevision, fileHashes, diagnostics: result.diagnostics };
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
    return { toolAudit: null };
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

function setup() {
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
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.AssetNotAllowed },
    });
    expect(journal.compositePending.size).toBe(0);
    expect(workspace.writes).toBe(0);
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
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.RecoveryRequired } });
    expect(workspace.files.get("one.html")).toBe("one-new");
    expect(journal.compositeOrphaned).toEqual([1]);
    expect(journal.compositeAborted).toEqual([]);
  });

  it("keeps all-landed bytes and returns the inline reconciled commit after T2b fails", async () => {
    const { authority, journal, reconciliation, workspace } = setup();
    workspace.files.set("index.html", "old");
    journal.compositeCommitError = new Error("T2 unavailable");
    reconciliation.outcome = {
      terminal: "committed",
      envelope: {
        projectRevision: 7,
        entityRevision: null,
        fileHashes: { ["index.html" as RelPath]: digest("new") },
        diagnostics: [],
      },
    };
    await expect(authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
      toolAudit: null,
      backup: false,
    }, "agent")).resolves.toMatchObject({ ok: true, value: { projectRevision: 7 } });
    expect(reconciliation.calls).toEqual([1]);
    expect(workspace.files.get("index.html")).toBe("new");
  });

  it("returns recovery_required after one failed inline reconcile without rolling all-landed bytes back", async () => {
    const { authority, journal, reconciliation, workspace } = setup();
    workspace.files.set("index.html", "old");
    journal.compositeCommitError = new Error("T2 unavailable");
    await expect(authority.mutateSource({
      ref: project,
      steps: [{ kind: "write", path: "index.html" as RelPath, content: "new", expectedContentHash: digest("old") }],
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
    }, "agent", { toolAudit })).resolves.toMatchObject({ ok: true });
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
