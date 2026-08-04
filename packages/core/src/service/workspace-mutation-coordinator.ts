import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type RelPath,
} from "@vidcom/contracts";

import type { AbsolutePath, ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { ClockPort, LeasePort, ProjectDirectoryPort, WorkspaceOperationJournalPort, WorkspacePort } from "../port/ports";
import type {
  MutationCapture,
  PendingWorkspaceOperation,
  ResolvedPath,
  WorkspaceOperationId,
  WorkspaceOperationStepState,
  WorkspaceWriteEnvelope,
  ProjectLifecycleCommit,
  PendingToolAudit,
} from "../port/types";
import { canonicalizeJson } from "./canonical-json";
import { inferMutationPurpose } from "./write-authority";

export interface WorkspaceWriteRequest {
  workspaceRoot: AbsolutePath;
  writes: Array<{
    path: RelPath;
    content: string | Uint8Array;
    fromHash: ContentHash | null;
  }>;
  actor: Actor;
  action: string;
  toolAudit?: PendingToolAudit | null;
}

export interface WorkspaceProjectCreateRequest {
  workspaceRoot: AbsolutePath;
  slug: string;
  projectId: import("@vidcom/contracts").ProjectId;
  files: Array<{ path: RelPath; content: string | Uint8Array }>;
  actor: Actor;
}

export interface WorkspaceProjectRenameRequest {
  workspaceRoot: AbsolutePath;
  projectId: import("@vidcom/contracts").ProjectId | null;
  fromSlug: string;
  toSlug: string;
  actor: Actor;
}

export interface WorkspaceProjectDeleteRequest {
  workspaceRoot: AbsolutePath;
  projectId: import("@vidcom/contracts").ProjectId | null;
  slug: string;
  verifiedBackupId: string;
  grantId?: string;
  actor: Actor;
}

export interface WorkspaceProjectLocation {
  projectId: import("@vidcom/contracts").ProjectId | null;
  slug: string;
  root: AbsolutePath;
  entry: RelPath;
}

export interface WorkspaceRecoveryReport {
  operationId: WorkspaceOperationId;
  terminal: "committed" | "recovered" | "aborted" | "orphaned";
}

export interface WorkspaceMutationCoordinatorDependencies {
  workspace: WorkspacePort;
  journal: WorkspaceOperationJournalPort;
  lease: LeasePort;
  leaseId: string;
  hashContent(content: string | Uint8Array): ContentHash;
  directories?: ProjectDirectoryPort;
  clock?: ClockPort;
}

class WorkspaceMutex {
  private readonly tails = new Map<AbsolutePath, Promise<void>>();

  async run<Value>(root: AbsolutePath, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.tails.get(root) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(root, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(root) === tail) this.tails.delete(root);
    }
  }
}

interface PreparedWorkspaceWrite {
  path: RelPath;
  target: ResolvedPath;
  content: string | Uint8Array;
  fromHash: ContentHash | null;
  toHash: ContentHash;
  previousContent: Uint8Array | null;
}

function operationError(error: unknown): DomainError {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  if (code === ErrorCode.WorkspaceLeaseLost || code === ErrorCode.WriteConflict) {
    return { code, message: error instanceof Error ? error.message : "workspace operation failed" };
  }
  return { code: ErrorCode.StorageUnavailable, message: "workspace operation storage failed" };
}

/** Internal workspace-scoped coordinator; usecases receive it only through WriteAuthority. */
export class WorkspaceMutationCoordinator {
  private readonly mutex = new WorkspaceMutex();

  constructor(private readonly dependencies: WorkspaceMutationCoordinatorDependencies) {}

  private lifecycleDependencies(): { directories: ProjectDirectoryPort; clock: ClockPort } {
    if (!this.dependencies.directories || !this.dependencies.clock) {
      throw new TypeError("project lifecycle coordination is unavailable");
    }
    return { directories: this.dependencies.directories, clock: this.dependencies.clock };
  }

  async createProjectRoot(request: WorkspaceProjectCreateRequest): Promise<Result<ProjectRef, DomainError>> {
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    return this.mutex.run(request.workspaceRoot, async () => {
      const { directories, clock } = this.lifecycleDependencies();
      const hashes = request.files.map((file) => this.dependencies.hashContent(file.content));
      let operationId: WorkspaceOperationId;
      try {
        operationId = await this.dependencies.journal.begin({
          workspaceRoot: request.workspaceRoot,
          kind: "project_create",
          projectId: request.projectId,
          fromPath: null,
          toPath: request.slug,
          stagingPath: null,
          backupId: null,
          actor: request.actor,
          action: "project.create",
        }, request.files.map((file, ordinal) => ({
          ordinal,
          path: file.path,
          fromHash: null,
          toHash: hashes[ordinal]!,
          previousContent: null,
        })), { leaseId: this.dependencies.leaseId });
      } catch (error) {
        return err(operationError(error));
      }
      let staged: { stagingRoot: AbsolutePath; finalRoot: AbsolutePath } | null = null;
      let published = false;
      try {
        staged = await directories.stageCreate(request.workspaceRoot, request.slug, operationId);
        await this.dependencies.journal.setDirectoryPaths(operationId, {
          stagingPath: staged.stagingRoot,
        });
        for (const ordinal of request.files.keys()) {
          await this.dependencies.journal.markStepCaptured(operationId, ordinal, null, null);
        }
        await directories.writeStagedFiles(staged.stagingRoot, request.files);
        await directories.publishCreate(staged.stagingRoot, staged.finalRoot);
        published = true;
        for (const ordinal of request.files.keys()) await this.dependencies.journal.markStepWritten(operationId, ordinal);
        const preview = request.files.find((file) => file.path === "preview-settings.json");
        if (!preview) throw new TypeError("project create is missing preview-settings.json");
        await this.dependencies.journal.commitProjectLifecycle(operationId, {
          kind: "create",
          projectId: request.projectId,
          workspaceRoot: request.workspaceRoot,
          slug: request.slug,
          actor: request.actor,
          manifestHash: this.dependencies.hashContent(canonicalizeJson(request.files.map((file, index) => ({
            path: file.path,
            contentHash: hashes[index],
          })))),
          previewSettingsHash: this.dependencies.hashContent(preview.content),
          occurredAt: clock.now().toISOString(),
        });
        return ok({ id: request.projectId, slug: request.slug, root: staged.finalRoot, entry: "index.html" as RelPath });
      } catch {
        if (!published) {
          if (staged) await directories.removeOwned(staged.stagingRoot).catch(() => {});
          await this.dependencies.journal.abort(operationId, ErrorCode.StorageUnavailable).catch(() => {});
          return err({ code: ErrorCode.StorageUnavailable, message: "project create failed before publication" });
        }
        return err({
          code: ErrorCode.RecoveryRequired,
          message: "project create was published but requires journal recovery",
          details: { operationId },
        });
      }
    });
  }

  async renameProjectRoot(request: WorkspaceProjectRenameRequest): Promise<Result<WorkspaceProjectLocation, DomainError>> {
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    return this.mutex.run(request.workspaceRoot, async () => {
      const { directories, clock } = this.lifecycleDependencies();
      const [fromRoot, toRoot] = await Promise.all([
        directories.projectRoot(request.workspaceRoot, request.fromSlug),
        directories.projectRoot(request.workspaceRoot, request.toSlug),
      ]);
      let operationId: WorkspaceOperationId;
      try {
        operationId = await this.dependencies.journal.begin({
          workspaceRoot: request.workspaceRoot,
          kind: "project_rename",
          projectId: request.projectId,
          fromPath: request.fromSlug,
          toPath: request.toSlug,
          stagingPath: null,
          backupId: null,
          actor: request.actor,
          action: "project.rename",
        }, [fromRoot, toRoot].map((root, ordinal) => ({
          ordinal,
          path: (ordinal === 0 ? request.fromSlug : request.toSlug) as RelPath,
          fromHash: null,
          toHash: null,
          previousContent: null,
        })), { leaseId: this.dependencies.leaseId });
        for (const ordinal of [0, 1]) await this.dependencies.journal.markStepCaptured(operationId, ordinal, null, null);
      } catch (error) {
        return err(operationError(error));
      }
      let renamed = false;
      try {
        await directories.rename(fromRoot, toRoot);
        renamed = true;
        for (const ordinal of [0, 1]) await this.dependencies.journal.markStepWritten(operationId, ordinal);
        await this.dependencies.journal.commitProjectLifecycle(operationId, {
          kind: "rename",
          projectId: request.projectId,
          workspaceRoot: request.workspaceRoot,
          fromSlug: request.fromSlug,
          toSlug: request.toSlug,
          actor: request.actor,
          occurredAt: clock.now().toISOString(),
        });
        return ok({ projectId: request.projectId, slug: request.toSlug, root: toRoot, entry: "index.html" as RelPath });
      } catch {
        if (!renamed) await this.dependencies.journal.abort(operationId, ErrorCode.StorageUnavailable).catch(() => {});
        return err({
          code: renamed ? ErrorCode.RecoveryRequired : ErrorCode.StorageUnavailable,
          message: renamed ? "project rename requires journal recovery" : "project rename failed before publication",
          details: { operationId },
        });
      }
    });
  }

  async deleteProjectRoot(request: WorkspaceProjectDeleteRequest): Promise<Result<{ backupId: string }, DomainError>> {
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    return this.mutex.run(request.workspaceRoot, async () => {
      const { directories, clock } = this.lifecycleDependencies();
      const projectRoot = await directories.projectRoot(request.workspaceRoot, request.slug);
      let operationId: WorkspaceOperationId;
      try {
        operationId = await this.dependencies.journal.begin({
          workspaceRoot: request.workspaceRoot,
          kind: "project_delete",
          projectId: request.projectId,
          fromPath: request.slug,
          toPath: null,
          stagingPath: null,
          backupId: request.verifiedBackupId,
          grantId: request.grantId ?? null,
          actor: request.actor,
          action: "project.delete",
        }, [{
          ordinal: 0,
          path: request.slug as RelPath,
          fromHash: null,
          toHash: null,
          previousContent: null,
        }], { leaseId: this.dependencies.leaseId });
        await this.dependencies.journal.markStepCaptured(operationId, 0, null, null);
      } catch (error) {
        return err(operationError(error));
      }
      let quarantine: AbsolutePath | null = null;
      try {
        quarantine = await directories.quarantine(projectRoot, operationId);
        await this.dependencies.journal.setDirectoryPaths(operationId, { stagingPath: quarantine });
        await this.dependencies.journal.markStepWritten(operationId, 0);
        await this.dependencies.journal.commitProjectLifecycle(operationId, {
          kind: "delete",
          projectId: request.projectId,
          workspaceRoot: request.workspaceRoot,
          slug: request.slug,
          backupId: request.verifiedBackupId,
          actor: request.actor,
          occurredAt: clock.now().toISOString(),
        });
        await directories.removeOwned(quarantine);
        return ok({ backupId: request.verifiedBackupId });
      } catch {
        if (!quarantine) await this.dependencies.journal.abort(operationId, ErrorCode.StorageUnavailable).catch(() => {});
        return err({
          code: quarantine ? ErrorCode.RecoveryRequired : ErrorCode.StorageUnavailable,
          message: quarantine ? "project delete requires recovery" : "project delete failed before quarantine",
          details: { operationId },
        });
      }
    });
  }

  async mutate(request: WorkspaceWriteRequest): Promise<Result<WorkspaceWriteEnvelope, DomainError>> {
    if (request.writes.length === 0 && !request.toolAudit) {
      return err({ code: ErrorCode.SchemaInvalid, message: "a workspace mutation must contain at least one write" });
    }
    if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
      return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
    }
    return this.mutex.run(request.workspaceRoot, async () => {
      if (!(await this.dependencies.lease.assertHeld(this.dependencies.leaseId))) {
        return err({ code: ErrorCode.WorkspaceLeaseLost, message: "the workspace write lease was lost" });
      }
      const prepared = await this.prepare(request);
      if (!prepared.ok) return prepared;
      return this.publish(request, prepared.value);
    });
  }

  private async prepare(
    request: WorkspaceWriteRequest,
  ): Promise<Result<PreparedWorkspaceWrite[], DomainError>> {
    const resolveWorkspace = this.dependencies.workspace.resolveWorkspace;
    const paths = new Set<RelPath>();
    const targets = new Set<ResolvedPath>();
    const prepared: PreparedWorkspaceWrite[] = [];
    for (const write of request.writes) {
      if (paths.has(write.path)) {
        return err({
          code: ErrorCode.DuplicateMutationTarget,
          message: "a workspace mutation cannot write the same path twice",
          details: { path: write.path },
        });
      }
      paths.add(write.path);
      if (inferMutationPurpose("workspace", write.path) !== "workspace-agent-kit") {
        return err({
          code: ErrorCode.AssetNotAllowed,
          message: "the path is not allowed for workspace mutation",
          details: { reason: "not_allowed_for_purpose", path: write.path },
        });
      }
      const resolved = await resolveWorkspace.call(
        this.dependencies.workspace,
        request.workspaceRoot,
        write.path,
        "workspace-agent-kit",
      );
      if (!resolved.ok) {
        return err({
          code: resolved.error.reason === "outside_project" || resolved.error.reason === "symlink_escape"
            ? ErrorCode.PathOutsideProject
            : resolved.error.reason === "invalid_syntax"
              ? ErrorCode.PathInvalid
              : ErrorCode.AssetNotAllowed,
          message: "the workspace path could not be authorized",
          details: { reason: resolved.error.reason, path: write.path },
        });
      }
      if (targets.has(resolved.value)) {
        return err({
          code: ErrorCode.DuplicateMutationTarget,
          message: "multiple workspace paths resolve to the same target",
          details: { path: write.path },
        });
      }
      targets.add(resolved.value);
      const current = await this.dependencies.workspace.readBytes(resolved.value);
      if ((current?.contentHash ?? null) !== write.fromHash) {
        return err({
          code: ErrorCode.WriteConflict,
          message: "the workspace file changed before the operation began",
          details: { path: write.path, currentHash: current?.contentHash ?? null },
        });
      }
      prepared.push({
        path: write.path,
        target: resolved.value,
        content: write.content,
        fromHash: write.fromHash,
        toHash: this.dependencies.hashContent(write.content),
        previousContent: current?.bytes ?? null,
      });
    }
    return ok(prepared);
  }

  private async publish(
    request: WorkspaceWriteRequest,
    writes: PreparedWorkspaceWrite[],
  ): Promise<Result<WorkspaceWriteEnvelope, DomainError>> {
    let operationId: WorkspaceOperationId;
    try {
      operationId = await this.dependencies.journal.begin({
        workspaceRoot: request.workspaceRoot,
        kind: "agent_kit_files",
        projectId: null,
        fromPath: null,
        toPath: null,
        stagingPath: null,
        actor: request.actor,
        action: request.action,
        toolAudit: request.toolAudit ?? null,
      }, writes.map((write, ordinal) => ({
        ordinal,
        path: write.path,
        fromHash: write.fromHash,
        toHash: write.toHash,
        previousContent: write.previousContent,
      })), { leaseId: this.dependencies.leaseId });
    } catch (error) {
      return err(operationError(error));
    }

    const captures: MutationCapture[] = [];
    const published = new Set<number>();
    try {
      for (const [ordinal, write] of writes.entries()) {
        const captured = await this.dependencies.workspace.captureForMutation(
          write.target,
          write.fromHash,
          operationId,
          ordinal,
        );
        if (!captured.ok) throw new Error("workspace capture precondition changed");
        captures.push(captured.value);
        await this.dependencies.journal.markStepCaptured(
          operationId,
          ordinal,
          captured.value.rollbackPath,
          captured.value.capturedHash,
        );
      }
      for (const [ordinal, write] of writes.entries()) {
        const capture = captures[ordinal];
        if (!capture) throw new Error("workspace capture disappeared before publish");
        if (!(await this.dependencies.workspace.publishCaptured(capture, write.content))) {
          throw new Error("workspace publish target was created concurrently");
        }
        published.add(ordinal);
        await this.dependencies.journal.markStepWritten(operationId, ordinal);
      }
      await this.dependencies.journal.commit(operationId);
      await this.discard(captures);
      return ok({
        operationId,
        fileHashes: Object.fromEntries(writes.map(({ path, toHash }) => [path, toHash])) as Record<RelPath, ContentHash>,
      });
    } catch {
      const restored = await this.restore(writes, captures, published);
      if (restored) {
        try {
          await this.dependencies.journal.rollback(operationId, ErrorCode.StorageUnavailable);
          await this.discard(captures);
          return err({ code: ErrorCode.StorageUnavailable, message: "the workspace batch failed and was restored" });
        } catch {
          return err({
            code: ErrorCode.RecoveryRequired,
            message: "the workspace was restored but its operation journal remains unresolved",
            details: { operationId },
          });
        }
      }
      await this.dependencies.journal.orphan(operationId, ErrorCode.RecoveryRequired).catch(() => {});
      return err({
        code: ErrorCode.RecoveryRequired,
        message: "the workspace batch could not be restored safely",
        details: { operationId },
      });
    }
  }

  private async restore(
    writes: readonly PreparedWorkspaceWrite[],
    captures: readonly MutationCapture[],
    published: ReadonlySet<number>,
  ): Promise<boolean> {
    for (const capture of [...captures].sort((left, right) => right.ordinal - left.ordinal)) {
      const write = writes[capture.ordinal];
      if (!write) return false;
      try {
        const landedHash = published.has(capture.ordinal) ? write.toHash : null;
        if (!(await this.dependencies.workspace.restoreCaptured(capture, landedHash))) return false;
        if (await this.dependencies.workspace.readHash(capture.target) !== write.fromHash) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  private async discard(captures: readonly MutationCapture[]): Promise<void> {
    await Promise.all(captures.map((capture) => this.dependencies.workspace.discardCapture(capture).catch(() => {})));
  }

  /** Reconciles whole unresolved batches; no step is ever terminalized independently. */
  async recoverPending(workspaceRoot: AbsolutePath): Promise<WorkspaceRecoveryReport[]> {
    return this.mutex.run(workspaceRoot, async () => {
      const reports: WorkspaceRecoveryReport[] = [];
      for (const operation of await this.dependencies.journal.listPending(workspaceRoot)) {
        reports.push(await this.recoverOne(operation));
      }
      return reports;
    });
  }

  private async recoverOne(operation: PendingWorkspaceOperation): Promise<WorkspaceRecoveryReport> {
    if (operation.kind !== "agent_kit_files") return this.recoverLifecycle(operation);
    const resolveWorkspace = this.dependencies.workspace.resolveWorkspace;
    const resolved: Array<WorkspaceOperationStepState & { target: ResolvedPath }> = [];
    for (const step of operation.steps) {
      const target = await resolveWorkspace.call(
        this.dependencies.workspace,
        operation.workspaceRoot,
        step.path,
        "workspace-agent-kit",
      );
      if (!target.ok) {
        await this.dependencies.journal.orphan(operation.id, ErrorCode.RecoveryRequired).catch(() => {});
        return { operationId: operation.id, terminal: "orphaned" };
      }
      resolved.push({ ...step, target: target.value });
    }
    const actual = await Promise.all(resolved.map((step) => this.dependencies.workspace.readHash(step.target)));
    if (resolved.every((step, index) => step.toHash !== null && actual[index] === step.toHash)) {
      try {
        for (const step of resolved) {
          if (step.status !== "written") {
            await this.dependencies.journal.markStepWritten(operation.id, step.ordinal);
          }
        }
        await this.dependencies.journal.recover(operation.id);
        await this.discard(resolved.map((step) => ({
          journalId: operation.id,
          ordinal: step.ordinal,
          target: step.target,
          rollbackPath: step.rollbackPath,
          capturedHash: step.capturedHash,
        })));
        return { operationId: operation.id, terminal: "recovered" };
      } catch {
        await this.dependencies.journal.orphan(operation.id, ErrorCode.RecoveryRequired).catch(() => {});
        return { operationId: operation.id, terminal: "orphaned" };
      }
    }
    if (resolved.every((step, index) => step.captureState === "pending" && actual[index] === step.fromHash)) {
      await this.dependencies.journal.abort(operation.id, ErrorCode.StorageUnavailable);
      return { operationId: operation.id, terminal: "aborted" };
    }
    const captures = resolved.filter((step) => step.captureState === "captured").map((step) => ({
      journalId: operation.id,
      ordinal: step.ordinal,
      target: step.target,
      rollbackPath: step.rollbackPath,
      capturedHash: step.capturedHash,
    }));
    const writes = resolved.map((step) => ({
      path: step.path,
      target: step.target,
      content: new Uint8Array(),
      fromHash: step.fromHash,
      toHash: step.toHash ?? this.dependencies.hashContent(new Uint8Array()),
      previousContent: step.previousContent instanceof Uint8Array
        ? step.previousContent
        : step.previousContent === null ? null : new TextEncoder().encode(step.previousContent),
    }));
    const published = new Set(resolved.filter((step, index) => actual[index] === step.toHash).map((step) => step.ordinal));
    if (await this.restore(writes, captures, published)) {
      await this.dependencies.journal.rollback(operation.id, ErrorCode.StorageUnavailable);
      await this.discard(captures);
      return { operationId: operation.id, terminal: "recovered" };
    }
    await this.dependencies.journal.orphan(operation.id, ErrorCode.RecoveryRequired).catch(() => {});
    return { operationId: operation.id, terminal: "orphaned" };
  }

  private async recoverLifecycle(operation: PendingWorkspaceOperation): Promise<WorkspaceRecoveryReport> {
    const { directories, clock } = this.lifecycleDependencies();
    const markWritten = async () => {
      for (const step of operation.steps) {
        if (step.captureState === "pending") {
          await this.dependencies.journal.markStepCaptured(operation.id, step.ordinal, null, null);
        }
        if (step.status !== "written") await this.dependencies.journal.markStepWritten(operation.id, step.ordinal);
      }
    };
    const orphan = async (): Promise<WorkspaceRecoveryReport> => {
      await this.dependencies.journal.orphan(operation.id, ErrorCode.RecoveryRequired).catch(() => {});
      return { operationId: operation.id, terminal: "orphaned" };
    };
    try {
      if (operation.kind === "project_create") {
        if (!operation.projectId || !operation.toPath) return orphan();
        const finalRoot = await directories.projectRoot(operation.workspaceRoot, operation.toPath);
        const finalState = await directories.inspect(finalRoot);
        const stagingState = operation.stagingPath
          ? await directories.inspect(operation.stagingPath as AbsolutePath)
          : "absent";
        if (finalState === "directory" && stagingState === "absent") {
          await markWritten();
          const preview = operation.steps.find((step) => step.path === "preview-settings.json")?.toHash;
          if (!preview) return orphan();
          const result: ProjectLifecycleCommit = {
            kind: "create",
            projectId: operation.projectId,
            workspaceRoot: operation.workspaceRoot,
            slug: operation.toPath,
            actor: operation.actor,
            manifestHash: this.dependencies.hashContent(canonicalizeJson(operation.steps.map((step) => ({
              path: step.path,
              contentHash: step.toHash,
            })))),
            previewSettingsHash: preview,
            occurredAt: clock.now().toISOString(),
          };
          await this.dependencies.journal.commitProjectLifecycle(operation.id, result, true);
          return { operationId: operation.id, terminal: "recovered" };
        }
        if (finalState === "absent" && stagingState === "directory" && operation.stagingPath) {
          await directories.removeOwned(operation.stagingPath as AbsolutePath);
          await this.dependencies.journal.abort(operation.id, ErrorCode.StorageUnavailable);
          return { operationId: operation.id, terminal: "aborted" };
        }
        if (finalState === "absent" && stagingState === "absent") {
          await this.dependencies.journal.abort(operation.id, ErrorCode.StorageUnavailable);
          return { operationId: operation.id, terminal: "aborted" };
        }
        return orphan();
      }

      if (operation.kind === "project_rename") {
        if (!operation.fromPath || !operation.toPath) return orphan();
        const [oldRoot, newRoot] = await Promise.all([
          directories.projectRoot(operation.workspaceRoot, operation.fromPath),
          directories.projectRoot(operation.workspaceRoot, operation.toPath),
        ]);
        const [oldState, newState] = await Promise.all([directories.inspect(oldRoot), directories.inspect(newRoot)]);
        if (oldState === "absent" && newState === "directory") {
          await markWritten();
          await this.dependencies.journal.commitProjectLifecycle(operation.id, {
            kind: "rename",
            projectId: operation.projectId,
            workspaceRoot: operation.workspaceRoot,
            fromSlug: operation.fromPath,
            toSlug: operation.toPath,
            actor: operation.actor,
            occurredAt: clock.now().toISOString(),
          }, true);
          return { operationId: operation.id, terminal: "recovered" };
        }
        if (oldState === "directory" && newState === "absent") {
          await this.dependencies.journal.abort(operation.id, ErrorCode.StorageUnavailable);
          return { operationId: operation.id, terminal: "aborted" };
        }
        return orphan();
      }

      if (!operation.fromPath || !operation.backupId) return orphan();
      const liveRoot = await directories.projectRoot(operation.workspaceRoot, operation.fromPath);
      const liveState = await directories.inspect(liveRoot);
      const quarantineState = operation.stagingPath
        ? await directories.inspect(operation.stagingPath as AbsolutePath)
        : "absent";
      if (liveState === "absent" && quarantineState === "directory" && operation.stagingPath) {
        await markWritten();
        await this.dependencies.journal.commitProjectLifecycle(operation.id, {
          kind: "delete",
          projectId: operation.projectId,
          workspaceRoot: operation.workspaceRoot,
          slug: operation.fromPath,
          backupId: operation.backupId,
          actor: operation.actor,
          occurredAt: clock.now().toISOString(),
        }, true);
        await directories.removeOwned(operation.stagingPath as AbsolutePath);
        return { operationId: operation.id, terminal: "recovered" };
      }
      if (liveState === "directory" && quarantineState === "absent") {
        await this.dependencies.journal.abort(operation.id, ErrorCode.StorageUnavailable);
        return { operationId: operation.id, terminal: "aborted" };
      }
      return orphan();
    } catch {
      return orphan();
    }
  }
}
