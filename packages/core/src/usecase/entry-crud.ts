import {
  ErrorCode,
  type Actor,
  type ContentHash,
  type DomainError,
  type ProjectId,
  type RelPath,
} from "@vidcom/contracts";

import { checkPathPurpose, checkPathSyntax } from "../domain/path-policy";
import type { ProjectRef } from "../domain/models";
import { err, ok, type Result } from "../error/result";
import type { MutationOrigin } from "../port/mutation-observer";
import type { MutationJournalPort, StagedSourceHandle, WorkspacePort } from "../port/ports";
import type { CompositeRequest, GrantBinding, WriteEnvelope, WriteInvocation } from "../port/types";
import { canonicalizeJson } from "../service/canonical-json";

const ENTRY_IO_CONCURRENCY = 8;

export type EntrySnapshot =
  | { relativePath: string; kind: "folder"; contentHash: null }
  | { relativePath: string; kind: "file"; contentHash: ContentHash };

interface ScannedEntry {
  rootKind: "file" | "folder";
  entries: EntrySnapshot[];
}

type EntryWorkspace = Pick<
  WorkspacePort,
  "readProjectRef" | "resolve" | "stat" | "readDirectory" | "readHash"
> & {
  openStagedSource: NonNullable<WorkspacePort["openStagedSource"]>;
};

export interface EntryCrudDependencies {
  workspace: EntryWorkspace;
  journal: Pick<MutationJournalPort, "latestRevision">;
  authority: {
    mutateSource(request: CompositeRequest, actor: Actor): Promise<Result<WriteEnvelope, DomainError>>;
  };
  hashContent(content: string | Uint8Array): ContentHash;
}

export interface DeleteEntryPlan {
  path: RelPath;
  recursive: boolean;
  expectedRevision: number;
  rootKind: "file" | "folder";
  entries: Array<{ path: RelPath; kind: "file" | "folder"; contentHash: ContentHash | null }>;
  targetHashes: Record<RelPath, ContentHash>;
  planDigest: ContentHash;
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try { return await operation(); }
    finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function validPath(value: RelPath): boolean {
  return !checkPathSyntax(value) && !checkPathPurpose(value, "authored-write");
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

function joinPath(root: RelPath, relativePath: string): RelPath {
  return (relativePath ? `${root}/${relativePath}` : root) as RelPath;
}

function relativeTo(root: RelPath, child: RelPath): string {
  return child === root ? "" : child.slice(root.length + 1);
}

function isBelow(path: RelPath, ancestor: RelPath): boolean {
  return path.startsWith(`${ancestor}/`);
}

function withoutHistory(invocation: WriteInvocation): WriteInvocation {
  const origin: MutationOrigin = {
    ...invocation.origin,
    historyAction: "ignore",
    historyOperation: null,
  };
  return { ...invocation, origin };
}

async function projectAtRevision(
  dependencies: EntryCrudDependencies,
  projectId: ProjectId,
  expectedRevision: number,
): Promise<Result<ProjectRef, DomainError>> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return err({ code: ErrorCode.SchemaInvalid, message: "expectedRevision must be a non-negative integer" });
  }
  try {
    const ref = await dependencies.workspace.readProjectRef(projectId);
    if (!ref) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
    const revision = (await dependencies.journal.latestRevision(projectId)) ?? 0;
    return revision === expectedRevision
      ? ok(ref)
      : err({
          code: ErrorCode.WriteConflict,
          message: "project revision changed before the file operation",
          details: { currentRevision: revision },
        });
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "project file state could not be read" });
  }
}

async function scanEntry(
  dependencies: EntryCrudDependencies,
  ref: ProjectRef,
  root: RelPath,
): Promise<Result<ScannedEntry, DomainError>> {
  const semaphore = new Semaphore(ENTRY_IO_CONCURRENCY);
  const walk = async (current: RelPath): Promise<Result<EntrySnapshot[], DomainError>> => {
    const resolved = await semaphore.run(() => dependencies.workspace.resolve(ref, current, "authored-write"));
    if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "entry path escaped the project" });
    const metadata = await semaphore.run(() => dependencies.workspace.stat(resolved.value));
    if (!metadata) return err({ code: ErrorCode.NotFound, message: "entry was not found" });
    const relativePath = relativeTo(root, current);
    if (metadata.kind === "file") {
      const contentHash = await semaphore.run(() => dependencies.workspace.readHash(resolved.value));
      return contentHash
        ? ok([{ relativePath, kind: "file", contentHash }])
        : err({ code: ErrorCode.WriteConflict, message: "entry changed while it was being read" });
    }
    if (metadata.kind !== "directory") {
      return err({ code: ErrorCode.AssetNotAllowed, message: "symlink and special entries cannot be changed" });
    }
    const children = await semaphore.run(() => dependencies.workspace.readDirectory(resolved.value));
    if (children === null) return err({ code: ErrorCode.WriteConflict, message: "directory changed while it was being read" });
    const invalid = children.find((entry) => entry.kind === "symlink" || entry.kind === "other");
    if (invalid) return err({ code: ErrorCode.AssetNotAllowed, message: "symlink and special entries cannot be changed" });
    const nested = await Promise.all([...children]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => walk(`${current}/${entry.name}` as RelPath)));
    const failed = nested.find((result) => !result.ok);
    if (failed && !failed.ok) return failed;
    return ok([
      ...(relativePath ? [{ relativePath, kind: "folder" as const, contentHash: null }] : []),
      ...nested.flatMap((result) => result.ok ? result.value : []),
    ]);
  };

  try {
    const resolved = await dependencies.workspace.resolve(ref, root, "authored-write");
    if (!resolved.ok) return err({ code: ErrorCode.PathOutsideProject, message: "entry path escaped the project" });
    const metadata = await dependencies.workspace.stat(resolved.value);
    if (!metadata) return err({ code: ErrorCode.NotFound, message: "entry was not found" });
    if (metadata.kind !== "file" && metadata.kind !== "directory") {
      return err({ code: ErrorCode.AssetNotAllowed, message: "symlink and special entries cannot be changed" });
    }
    const scanned = await walk(root);
    return scanned.ok ? ok({ rootKind: metadata.kind === "file" ? "file" : "folder", entries: scanned.value }) : scanned;
  } catch {
    return err({ code: ErrorCode.StorageUnavailable, message: "entry tree could not be read" });
  }
}

function orderedEntries(entries: readonly EntrySnapshot[]): EntrySnapshot[] {
  return [...entries].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function entryTreeDigest(
  entries: readonly EntrySnapshot[],
  hashContent: EntryCrudDependencies["hashContent"],
): ContentHash {
  return hashContent(canonicalizeJson(orderedEntries(entries)));
}

async function openSources(
  dependencies: EntryCrudDependencies,
  ref: ProjectRef,
  root: RelPath,
  files: readonly Extract<EntrySnapshot, { kind: "file" }>[],
): Promise<Result<StagedSourceHandle[], DomainError>> {
  const handles: StagedSourceHandle[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(ENTRY_IO_CONCURRENCY, files.length) }, async () => {
    while (true) {
      const index = next++;
      const file = files[index];
      if (!file) return;
      const handle = await dependencies.workspace.openStagedSource(
        ref,
        joinPath(root, file.relativePath),
        file.contentHash,
      );
      handles[index] = handle;
    }
  });
  try {
    await Promise.all(workers);
    return ok(handles);
  } catch {
    await Promise.allSettled(handles.map((handle) => handle.discard()));
    return err({ code: ErrorCode.StorageUnavailable, message: "entry sources could not be staged" });
  }
}

async function discardSources(handles: readonly StagedSourceHandle[]): Promise<void> {
  await Promise.allSettled(handles.map((handle) => handle.discard()));
}

export async function createEntry(
  dependencies: EntryCrudDependencies,
  input: { projectId: ProjectId; path: RelPath; kind: "file" | "folder"; expectedRevision: number },
  actor: Actor,
  invocation: WriteInvocation,
): Promise<Result<{ path: RelPath; kind: "file" | "folder"; envelope: WriteEnvelope }, DomainError>> {
  if (!validPath(input.path)) return err({ code: ErrorCode.PathInvalid, message: "entry path is not allowed" });
  const project = await projectAtRevision(dependencies, input.projectId, input.expectedRevision);
  if (!project.ok) return project;
  const current = await dependencies.workspace.resolve(project.value, input.path, "authored-write");
  if (!current.ok) return err({ code: ErrorCode.PathOutsideProject, message: "entry path escaped the project" });
  if (await dependencies.workspace.stat(current.value)) {
    return err({ code: ErrorCode.WriteConflict, message: "entry already exists" });
  }
  const fresh = await projectAtRevision(dependencies, input.projectId, input.expectedRevision);
  if (!fresh.ok) return fresh;
  const request = withoutHistory(invocation);
  const written = await dependencies.authority.mutateSource({
    ref: project.value,
    steps: input.kind === "file"
      ? [{ kind: "write", path: input.path, content: "", expectedContentHash: null }]
      : [{ kind: "mkdir", path: input.path, expectExisting: "absent" }],
    ...request,
    backup: false,
  }, actor);
  return written.ok ? ok({ path: input.path, kind: input.kind, envelope: written.value }) : written;
}

export async function renameEntry(
  dependencies: EntryCrudDependencies,
  input: {
    projectId: ProjectId;
    from: RelPath;
    to: RelPath;
    expectedRevision: number;
    expected:
      | { kind: "file"; contentHash: ContentHash }
      | { kind: "folder"; treeDigest: ContentHash };
  },
  actor: Actor,
  invocation: WriteInvocation,
): Promise<Result<{ from: RelPath; to: RelPath; envelope: WriteEnvelope; backupId: string }, DomainError>> {
  if (!validPath(input.from) || !validPath(input.to)) {
    return err({ code: ErrorCode.PathInvalid, message: "entry path is not allowed" });
  }
  if (input.from === input.to || isBelow(input.to, input.from) || isBelow(input.from, input.to)) {
    return err({ code: ErrorCode.PathInvalid, message: "rename source and target cannot contain each other" });
  }
  const project = await projectAtRevision(dependencies, input.projectId, input.expectedRevision);
  if (!project.ok) return project;
  const scanned = await scanEntry(dependencies, project.value, input.from);
  if (!scanned.ok) return scanned;
  if (scanned.value.rootKind !== input.expected.kind) {
    return err({ code: ErrorCode.WriteConflict, message: "entry kind changed before rename" });
  }
  if (input.expected.kind === "file") {
    const current = scanned.value.entries[0];
    if (current?.kind !== "file" || current.contentHash !== input.expected.contentHash) {
      return err({ code: ErrorCode.WriteConflict, message: "file changed before rename" });
    }
  } else if (entryTreeDigest(scanned.value.entries, dependencies.hashContent) !== input.expected.treeDigest) {
    return err({ code: ErrorCode.WriteConflict, message: "directory tree changed before rename" });
  }
  const target = await dependencies.workspace.resolve(project.value, input.to, "authored-write");
  if (!target.ok) return err({ code: ErrorCode.PathOutsideProject, message: "rename target escaped the project" });
  if (await dependencies.workspace.stat(target.value)) {
    return err({ code: ErrorCode.WriteConflict, message: "rename target already exists" });
  }
  const fresh = await projectAtRevision(dependencies, input.projectId, input.expectedRevision);
  if (!fresh.ok) return fresh;
  const files = orderedEntries(scanned.value.entries)
    .filter((entry): entry is Extract<EntrySnapshot, { kind: "file" }> => entry.kind === "file");
  const staged = await openSources(dependencies, project.value, input.from, files);
  if (!staged.ok) return staged;
  try {
    const directories = orderedEntries(scanned.value.entries)
      .filter((entry): entry is Extract<EntrySnapshot, { kind: "folder" }> => entry.kind === "folder");
    const targetDirectories = scanned.value.rootKind === "folder"
      ? [input.to, ...directories.map((entry) => joinPath(input.to, entry.relativePath))]
      : [];
    const sourceDirectories = scanned.value.rootKind === "folder"
      ? [input.from, ...directories.map((entry) => joinPath(input.from, entry.relativePath))]
      : [];
    const steps: CompositeRequest["steps"] = [
      ...targetDirectories
        .sort((left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right))
        .map((path) => ({ kind: "mkdir" as const, path, expectExisting: "absent" as const })),
      ...files.map((file, index) => ({
        kind: "write-staged" as const,
        path: joinPath(input.to, file.relativePath),
        source: staged.value[index]!.source,
        expectedContentHash: null,
        undoable: false,
      })),
      ...files.map((file) => ({
        kind: "delete" as const,
        path: joinPath(input.from, file.relativePath),
        expectedContentHash: file.contentHash,
      })),
      ...sourceDirectories
        .sort((left, right) => pathDepth(right) - pathDepth(left) || left.localeCompare(right))
        .map((path) => ({ kind: "rmdir" as const, path, expectEmpty: true as const })),
    ];
    const written = await dependencies.authority.mutateSource({
      ref: project.value,
      steps,
      ...withoutHistory(invocation),
      backup: true,
    }, actor);
    if (!written.ok) return written;
    const backupId = "backupId" in written.value && typeof written.value.backupId === "string"
      ? written.value.backupId
      : null;
    return backupId
      ? ok({ from: input.from, to: input.to, envelope: written.value, backupId })
      : err({ code: ErrorCode.BackupFailed, message: "rename returned no backup ID" });
  } finally {
    await discardSources(staged.value);
  }
}

export async function prepareDeleteEntry(
  dependencies: EntryCrudDependencies,
  input: { projectId: ProjectId; path: RelPath; recursive: boolean; expectedRevision: number },
): Promise<Result<{ plan: DeleteEntryPlan; binding: GrantBinding }, DomainError>> {
  if (!validPath(input.path)) return err({ code: ErrorCode.PathInvalid, message: "entry path is not allowed" });
  const project = await projectAtRevision(dependencies, input.projectId, input.expectedRevision);
  if (!project.ok) return project;
  const scanned = await scanEntry(dependencies, project.value, input.path);
  if (!scanned.ok) return scanned;
  if (scanned.value.rootKind === "folder" && scanned.value.entries.length > 0 && !input.recursive) {
    return err({ code: ErrorCode.ConfirmationRequired, message: "recursive confirmation is required for a non-empty directory" });
  }
  const entries = scanned.value.rootKind === "file"
    ? scanned.value.entries.map((entry) => ({ path: input.path, kind: entry.kind, contentHash: entry.contentHash }))
    : [
        ...scanned.value.entries.map((entry) => ({
          path: joinPath(input.path, entry.relativePath),
          kind: entry.kind,
          contentHash: entry.contentHash,
        })),
        { path: input.path, kind: "folder" as const, contentHash: null },
      ];
  const targetHashes = Object.fromEntries(entries.flatMap((entry) =>
    entry.kind === "file" && entry.contentHash ? [[entry.path, entry.contentHash]] : [])) as Record<RelPath, ContentHash>;
  const planBase = {
    path: input.path,
    recursive: input.recursive,
    expectedRevision: input.expectedRevision,
    rootKind: scanned.value.rootKind,
    entries,
    targetHashes,
  };
  const planDigest = dependencies.hashContent(canonicalizeJson(planBase));
  const plan: DeleteEntryPlan = { ...planBase, planDigest };
  return ok({
    plan,
    binding: {
      tool: "delete_entry",
      projectId: input.projectId,
      target: input.path,
      expectedRevision: input.expectedRevision,
      planDigest,
      targetHashes,
    },
  });
}

export async function executeDeleteEntry(
  dependencies: EntryCrudDependencies,
  input: { projectId: ProjectId; path: RelPath; recursive: boolean; expectedRevision: number; grantId: string },
  actor: Actor,
  invocation: WriteInvocation,
): Promise<Result<{ deleted: RelPath; envelope: WriteEnvelope; backupId: string }, DomainError>> {
  const prepared = await prepareDeleteEntry(dependencies, input);
  if (!prepared.ok) return prepared;
  const project = await dependencies.workspace.readProjectRef(input.projectId);
  if (!project) return err({ code: ErrorCode.ProjectNotFound, message: "project was not found" });
  const files = prepared.value.plan.entries.filter((entry) => entry.kind === "file" && entry.contentHash !== null);
  const directories = prepared.value.plan.entries.filter((entry) => entry.kind === "folder");
  const written = await dependencies.authority.mutateSource({
    ref: project,
    steps: [
      ...files.sort((left, right) => left.path.localeCompare(right.path)).map((entry) => ({
        kind: "delete" as const,
        path: entry.path,
        expectedContentHash: entry.contentHash!,
      })),
      ...directories.sort((left, right) => pathDepth(right.path) - pathDepth(left.path) || left.path.localeCompare(right.path))
        .map((entry) => ({ kind: "rmdir" as const, path: entry.path, expectEmpty: true as const })),
    ],
    ...withoutHistory(invocation),
    backup: true,
    grant: { id: input.grantId, binding: prepared.value.binding },
  }, actor);
  if (!written.ok) return written;
  const backupId = "backupId" in written.value && typeof written.value.backupId === "string"
    ? written.value.backupId
    : null;
  return backupId
    ? ok({ deleted: input.path, envelope: written.value, backupId })
    : err({ code: ErrorCode.BackupFailed, message: "deletion returned no backup ID" });
}
