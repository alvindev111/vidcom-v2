// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { ContentHash, PreviewSettingsDto, ProjectId, RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  ok,
  type AbsolutePath,
  type CompositeRequest,
  type MutationOrigin,
  type MutationReceipt,
  type ProjectRef,
  type StagedFileSource,
  type UndoContentPort,
  type UndoContentRef,
  type WriteEnvelope,
} from "@vidcom/core";
import { applyMutationInverse, type ProjectWriteDependencies } from "@vidcom/core";

const projectId = "project_inverse" as ProjectId;
const project: ProjectRef = {
  id: projectId,
  slug: "inverse",
  root: "/workspace/inverse" as AbsolutePath,
  entry: "index.html" as RelPath,
};

const hash = (id: string) => `sha256:${id}` as ContentHash;

function inline(id: string, text: string): UndoContentRef {
  return { kind: "inline", bytes: new TextEncoder().encode(text), encoding: "utf8", contentHash: hash(id) };
}

function object(id: string): UndoContentRef {
  return { kind: "object", encoding: "binary", contentHash: hash(id) };
}

const operation = { id: "operation-1", targetReceiptId: "receipt-original" };
const undoOrigin: MutationOrigin = {
  kind: "ui",
  sessionId: "01K1ABCDEFGHJKMNPQRSTVWXYZ",
  label: "Undo edit",
  historyAction: "undo",
  historyOperation: operation,
};
const redoOrigin: MutationOrigin = { ...undoOrigin, label: "Redo edit", historyAction: "redo" };

function baseReceipt(steps: MutationReceipt["steps"], readGuards: MutationReceipt["readGuards"] = []): MutationReceipt {
  return {
    id: "receipt-original",
    projectId,
    origin: { ...undoOrigin, historyAction: "record", historyOperation: null },
    steps,
    paths: steps.flatMap((step) => step.kind === "file" || step.kind === "directory"
      ? [step.path]
      : step.kind === "entity" ? [step.backingPath] : []),
    readGuards,
    projectRevision: 9,
    at: "2026-08-18T00:00:00.000Z",
    undoable: true,
  };
}

function fixture(options: {
  entityState?: { revision: number; contentHash: ContentHash; backingPath: RelPath };
  resolveError?: boolean;
} = {}) {
  const requests: CompositeRequest[] = [];
  const inverseReceipt = baseReceipt([]);
  inverseReceipt.id = "receipt-inverse";
  const envelope: WriteEnvelope = {
    projectRevision: 10,
    entityRevision: null,
    fileHashes: {},
    diagnostics: [],
    changeSeq: 3,
    inverseReceipt,
  };
  const content: UndoContentPort = {
    async retainBytes() { throw new Error("not used"); },
    async retainFile() { throw new Error("not used"); },
    async resolve(ref) {
      if (options.resolveError) throw new Error("injected resolve failure");
      if (ref.kind === "inline") return ref.bytes;
      return {
        sourcePath: `/app-data/objects/${ref.contentHash}` as AbsolutePath,
        contentHash: ref.contentHash,
      } satisfies StagedFileSource;
    },
    release() {},
  };
  const dependencies = {
    workspace: {
      async readProjectRef(id: ProjectId) { return id === projectId ? project : null; },
    },
    composition: {},
    journal: {
      async readEntityState() { return options.entityState ?? null; },
    },
    authority: {
      async mutateSource(request: CompositeRequest) {
        requests.push(request);
        return ok(envelope);
      },
    },
    clock: { now: () => new Date("2026-08-18T00:00:00.000Z") },
    undoContent: content,
  } as unknown as ProjectWriteDependencies;
  return { dependencies, requests, inverseReceipt };
}

describe("applyMutationInverse", () => {
  it("undoes file and directory steps in reverse order without materializing object refs", async () => {
    const created = inline("created", "created");
    const previous = object("previous");
    const replacement = inline("replacement", "replacement");
    const deleted = inline("deleted", "deleted");
    const target = baseReceipt([
      { kind: "directory", undoable: true, op: "mkdir", path: "group" as RelPath, existedBefore: false },
      { kind: "file", undoable: true, path: "group/created.html" as RelPath, beforeContent: null, afterContent: created, fromHash: null, toHash: created.contentHash },
      { kind: "file", undoable: true, path: "group/replaced.bin" as RelPath, beforeContent: previous, afterContent: replacement, fromHash: previous.contentHash, toHash: replacement.contentHash },
      { kind: "file", undoable: true, path: "group/deleted.html" as RelPath, beforeContent: deleted, afterContent: null, fromHash: deleted.contentHash, toHash: null },
      { kind: "directory", undoable: true, op: "mkdir", path: "group/sub" as RelPath, existedBefore: false },
    ]);
    const runtime = fixture();

    const result = await applyMutationInverse(
      runtime.dependencies,
      { projectId, receipt: target, direction: "undo" },
      "user",
      undoOrigin,
    );

    expect(result).toEqual({ ok: true, value: { envelope: expect.any(Object), inverse: runtime.inverseReceipt } });
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]).toMatchObject({
      origin: undoOrigin,
      backup: true,
      historyReadGuards: [],
      steps: [
        { kind: "rmdir", path: "group/sub", expectEmpty: true },
        { kind: "write", path: "group/deleted.html", content: "deleted", expectedContentHash: null },
        {
          kind: "write-staged",
          path: "group/replaced.bin",
          source: { contentHash: previous.contentHash },
          expectedContentHash: replacement.contentHash,
          undoable: true,
        },
        { kind: "delete", path: "group/created.html", expectedContentHash: created.contentHash },
        { kind: "rmdir", path: "group", expectEmpty: true },
      ],
    });
  });

  it("redoes in original order and carries read guards", async () => {
    const created = inline("created", "created");
    const before = inline("before", "before");
    const after = inline("after", "after");
    const removed = inline("removed", "removed");
    const guards = [{ path: "assets/shared.png" as RelPath, state: { kind: "file" as const, contentHash: hash("shared") } }];
    const target = baseReceipt([
      { kind: "directory", undoable: true, op: "mkdir", path: "group" as RelPath, existedBefore: false },
      { kind: "file", undoable: true, path: "group/created.html" as RelPath, beforeContent: null, afterContent: created, fromHash: null, toHash: created.contentHash },
      { kind: "file", undoable: true, path: "group/replaced.html" as RelPath, beforeContent: before, afterContent: after, fromHash: before.contentHash, toHash: after.contentHash },
      { kind: "file", undoable: true, path: "group/removed.html" as RelPath, beforeContent: removed, afterContent: null, fromHash: removed.contentHash, toHash: null },
    ], guards);
    const runtime = fixture();

    await applyMutationInverse(runtime.dependencies, { projectId, receipt: target, direction: "redo" }, "user", redoOrigin);

    expect(runtime.requests[0]).toMatchObject({
      origin: redoOrigin,
      backup: true,
      historyReadGuards: guards,
      steps: [
        { kind: "mkdir", path: "group", expectExisting: "absent" },
        { kind: "write", path: "group/created.html", content: "created", expectedContentHash: null },
        { kind: "write", path: "group/replaced.html", content: "after", expectedContentHash: before.contentHash },
        { kind: "delete", path: "group/removed.html", expectedContentHash: removed.contentHash },
      ],
    });
  });

  it("restores full entity state and reopens or recloses pending mounts in the same composite", async () => {
    const before = structuredClone(DEFAULT_PREVIEW_SETTINGS) as PreviewSettingsDto;
    const after = structuredClone(DEFAULT_PREVIEW_SETTINGS) as PreviewSettingsDto;
    before.scenes = { kept: { transitionSound: "chime", revealSound: "ping", hidden: false } };
    after.scenes = {
      ...before.scenes,
      removedByUndo: { transitionSound: "gong", revealSound: "pop", hidden: true },
    };
    const entity = {
      kind: "entity" as const,
      undoable: true,
      entity: "preview-settings" as const,
      backingPath: "preview-settings.json" as RelPath,
      beforeState: before,
      afterState: after,
      fromRevision: 7,
      toRevision: 8,
      fromHash: hash("entity-before"),
      toHash: hash("entity-after"),
    };
    const pending = {
      kind: "pending-mount" as const,
      undoable: true as const,
      operationId: "01K1ABCDEFGHJKMNPQRSTVWXYZ",
      before: { state: "uploaded_unmounted" as const, lastFailure: { code: "probe", message: "retry" } },
      after: { state: "mounted" as const, sceneId: "scene-mounted", revision: 9 },
    };
    const undo = fixture({
      entityState: { revision: 42, contentHash: entity.toHash, backingPath: entity.backingPath },
    });

    await applyMutationInverse(undo.dependencies, { projectId, receipt: baseReceipt([entity, pending]), direction: "undo" }, "user", undoOrigin);

    expect(undo.requests[0]).toMatchObject({
      steps: [{
        kind: "entity",
        entity: "preview-settings",
        expectedRevision: 42,
        expectedContentHash: entity.toHash,
        undoable: true,
        patch: { scenes: before.scenes, scenesRemove: ["removedByUndo"] },
      }],
      pendingMountTransition: {
        kind: "reopen",
        operationId: pending.operationId,
        expectedSceneId: "scene-mounted",
        restoreFailure: pending.before.lastFailure,
      },
    });

    const redo = fixture({
      entityState: { revision: 43, contentHash: entity.fromHash!, backingPath: entity.backingPath },
    });
    await applyMutationInverse(redo.dependencies, { projectId, receipt: baseReceipt([entity, pending]), direction: "redo" }, "user", redoOrigin);
    expect(redo.requests[0]).toMatchObject({
      steps: [{
        kind: "entity",
        expectedRevision: 43,
        expectedContentHash: entity.fromHash,
        patch: { scenes: after.scenes },
      }],
      pendingMountTransition: {
        kind: "close",
        operationId: pending.operationId,
        sceneId: "scene-mounted",
        previousFailure: pending.before.lastFailure,
      },
    });
  });

  it("fails before calling WriteAuthority when content resolution is unavailable", async () => {
    const target = baseReceipt([{
      kind: "file",
      undoable: true,
      path: "index.html" as RelPath,
      beforeContent: object("before"),
      afterContent: inline("after", "after"),
      fromHash: hash("before"),
      toHash: hash("after"),
    }]);
    const runtime = fixture({ resolveError: true });

    await expect(applyMutationInverse(
      runtime.dependencies,
      { projectId, receipt: target, direction: "undo" },
      "user",
      undoOrigin,
    )).resolves.toMatchObject({ ok: false, error: { code: "storage_unavailable" } });
    expect(runtime.requests).toEqual([]);
  });
});
