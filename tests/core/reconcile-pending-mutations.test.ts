import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  err,
  ok,
  reconcilePendingMutations,
  type AbsolutePath,
  type EntityState,
  type JournalId,
  type MutationIntent,
  type MutationJournalPort,
  type MutationResult,
  type PendingMutation,
  type ProjectRef,
  type ResolvedPath,
  type WorkspacePort,
} from "@vidcom/core";

const projectId = "project-1" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "project",
  root: "/workspace/project" as AbsolutePath,
  entry: "index.html" as RelPath,
};

function hash(value: string): ContentHash {
  return `sha256:${value.padEnd(64, "0")}` as ContentHash;
}

function pending(id: number, overrides: Partial<MutationIntent> = {}): PendingMutation {
  return {
    id: id as JournalId,
    projectId,
    kind: "file",
    path: `file-${id}.html` as RelPath,
    entity: null,
    fromHash: hash(`from-${id}`),
    previousContent: `old-${id}`,
    toHash: hash(`to-${id}`),
    actor: "user",
    ...overrides,
  };
}

class FakeJournal implements MutationJournalPort {
  aborted: Array<{ id: JournalId; reason: ErrorCode }> = [];
  recovered: Array<{ id: JournalId; result: MutationResult }> = [];
  orphaned: Array<{ id: JournalId; actualHash: ContentHash | null }> = [];

  constructor(readonly rows: PendingMutation[]) {}

  async begin(): Promise<JournalId> { throw new Error("unused"); }
  async commit(): Promise<number> { throw new Error("unused"); }
  async abort(id: JournalId, reason: ErrorCode) { this.aborted.push({ id, reason }); }
  async listPending() { return this.rows; }
  async latestRevision() { return null; }
  async latestSourceRevision() { return null; }
  async readRevisionRollbackPayload() {
    return err({ code: ErrorCode.NotFound, message: "unused" });
  }
  async readEntityState(): Promise<EntityState | null> {
    return { revision: 2, contentHash: hash("entity-old"), backingPath: "preview-settings.json" as RelPath };
  }
  async findProjectRegistration() { return null; }
  async registerProject() {}
  async beginBootstrap(): Promise<JournalId> { throw new Error("unused"); }
  async recover(id: JournalId, result: MutationResult) {
    this.recovered.push({ id, result });
    return 1;
  }
  async orphan(id: JournalId, actualHash: ContentHash | null) {
    this.orphaned.push({ id, actualHash });
  }
}

function workspace(actualHashes: Map<string, ContentHash | null>): WorkspacePort {
  return {
    async resolve(_ref, path) { return ok(`/workspace/project/${path}` as ResolvedPath); },
    async resolveWorkspace() { throw new Error("unused"); },
    async listProjects() { return [ref]; },
    async readProjectRef() { return ref; },
    async readFile() { return null; },
    async readBytes() { return null; },
    async readHash(path) { return actualHashes.get(path) ?? null; },
    async writeAtomic() {},
    async exists(path) { return actualHashes.get(path) !== null && actualHashes.has(path); },
    async deleteAtomic(path) { actualHashes.set(path, null); },
    async captureForMutation() { throw new Error("unused"); },
    async publishCaptured() { throw new Error("unused"); },
    async restoreCaptured() { throw new Error("unused"); },
    async discardCapture() {},
    async readTree() { return []; },
    async stat() { return null; },
  };
}

describe("reconcilePendingMutations", () => {
  it("handles every hash branch and surfaces orphan journal IDs", async () => {
    const untouched = pending(1);
    const written = pending(2);
    const ambiguous = pending(3);
    const missingNewFile = pending(4, { fromHash: null, previousContent: null });
    const missingProject = pending(5, { projectId: "missing-project" as ProjectId });
    const thirdHash = hash("third");
    const journal = new FakeJournal([untouched, written, ambiguous, missingNewFile, missingProject]);
    const hashes = new Map<string, ContentHash | null>([
      [`/workspace/project/${untouched.path}`, untouched.fromHash],
      [`/workspace/project/${written.path}`, written.toHash],
      [`/workspace/project/${ambiguous.path}`, thirdHash],
      [`/workspace/project/${missingNewFile.path}`, null],
    ]);

    const report = await reconcilePendingMutations({
      workspace: workspace(hashes),
      journal,
      async resolveProjectRef(id) { return id === missingProject.projectId ? null : ref; },
    });

    expect(report.aborted).toEqual([untouched.id, missingNewFile.id]);
    expect(journal.aborted).toEqual([
      { id: untouched.id, reason: ErrorCode.StorageUnavailable },
      { id: missingNewFile.id, reason: ErrorCode.StorageUnavailable },
    ]);
    expect(report.recovered).toEqual([written.id]);
    expect(journal.recovered[0]).toMatchObject({
      id: written.id,
      result: { previousContent: written.previousContent, event: { type: "file.changed" } },
    });
    expect(report.orphaned).toEqual([ambiguous.id, missingProject.id]);
    expect(journal.orphaned).toEqual([
      { id: ambiguous.id, actualHash: thirdHash },
      { id: missingProject.id, actualHash: null },
    ]);
  });

  it("uses entity backing state and emits project.changed during recovery", async () => {
    const mutation = pending(6, {
      kind: "entity",
      path: null,
      entity: "preview-settings",
      fromHash: hash("entity-old"),
      toHash: hash("entity-new"),
    });
    const journal = new FakeJournal([mutation]);
    const report = await reconcilePendingMutations({
      workspace: workspace(new Map([["/workspace/project/preview-settings.json", mutation.toHash]])),
      journal,
      async resolveProjectRef() { return ref; },
    });

    expect(report).toEqual({ aborted: [], recovered: [mutation.id], orphaned: [] });
    expect(journal.recovered[0]?.result.event).toEqual({
      type: "project.changed",
      projectId,
      payload: { entity: "preview-settings" },
    });
  });
});
