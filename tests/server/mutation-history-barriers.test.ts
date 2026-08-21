// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { MutationOrigin, MutationReceipt, UndoContentPort } from "@vidcom/core";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { MutationHistory } from "../../packages/server/src/service/mutation-history";

const projectId = "project_barriers" as ProjectId;

const content: UndoContentPort = {
  async retainBytes() { throw new Error("not used"); },
  async retainFile() { throw new Error("not used"); },
  async resolve() { throw new Error("not used"); },
  release() {},
};

function mutationOrigin(
  sessionId: string | null,
  historyAction: MutationOrigin["historyAction"] = "record",
  historyOperation: MutationOrigin["historyOperation"] = null,
): MutationOrigin {
  return {
    kind: sessionId === null ? "mcp" : "ui",
    sessionId,
    label: sessionId === null ? null : `label ${sessionId}`,
    historyAction,
    historyOperation,
  };
}

function receipt(
  id: string,
  sessionId: string | null,
  paths: RelPath[],
  options: {
    action?: MutationOrigin["historyAction"];
    operation?: MutationOrigin["historyOperation"];
    guards?: MutationReceipt["readGuards"];
    undoable?: boolean;
  } = {},
): MutationReceipt {
  return {
    id,
    projectId,
    origin: mutationOrigin(sessionId, options.action, options.operation),
    steps: [],
    paths,
    readGuards: options.guards ?? [],
    projectRevision: 1,
    at: "2026-08-18T00:00:00.000Z",
    undoable: options.undoable ?? true,
  };
}

function history(): MutationHistory {
  let operation = 0;
  return new MutationHistory(content, { operationId: () => `operation-${++operation}` });
}

function attach(value: MutationHistory, studio = "studio"): void {
  value.attach(`browser-${studio}`, studio, projectId);
}

function undoTop(value: MutationHistory, studio = "studio", inversePath = "inverse.html" as RelPath): void {
  const begun = value.begin(studio, projectId, "undo");
  if (!begun.ok) throw new Error("expected undo reservation");
  const operation = { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id };
  const origin = mutationOrigin(studio, "undo", operation);
  expect(value.claimHistoryOperation(projectId, origin)).toEqual({ ok: true });
  expect(value.emit(receipt(`inverse-${operation.id}`, studio, [inversePath], {
    action: "undo",
    operation,
  }))).toEqual({ ok: true });
}

function redoTop(value: MutationHistory, studio = "studio", inversePath = "inverse.html" as RelPath): void {
  const begun = value.begin(studio, projectId, "redo");
  if (!begun.ok) throw new Error("expected redo reservation");
  const operation = { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id };
  const origin = mutationOrigin(studio, "redo", operation);
  expect(value.claimHistoryOperation(projectId, origin)).toEqual({ ok: true });
  expect(value.emit(receipt(`inverse-${operation.id}`, studio, [inversePath], {
    action: "redo",
    operation,
  }))).toEqual({ ok: true });
}

describe("MutationHistory directional barriers", () => {
  it("uses segment-safe ownership overlap", () => {
    const value = history();
    attach(value);
    value.emit(receipt("owned", "studio", ["assets/a" as RelPath]));

    value.emit(receipt("sibling", null, ["assets/ab" as RelPath], { action: "ignore" }));
    expect(value.state("studio", projectId)).toMatchObject({ canUndo: true, undoBlocked: false });

    value.emit(receipt("descendant", null, ["assets/a/child.png" as RelPath], { action: "ignore" }));
    expect(value.state("studio", projectId)).toMatchObject({ canUndo: false, undoBlocked: true });
  });

  it("treats a same-session non-undoable record as an outside barrier", () => {
    const value = history();
    attach(value);
    value.emit(receipt("undoable", "studio", ["scenes/shared.html" as RelPath]));

    value.emit(receipt("non-undoable", "studio", ["scenes/shared.html" as RelPath], { undoable: false }));

    expect(value.state("studio", projectId)).toMatchObject({ depth: 1, canUndo: false, undoBlocked: true });
  });

  it("allows undo after a dependency edit but blocks the later redo", () => {
    const value = history();
    attach(value);
    value.emit(receipt("mount", "studio", ["scenes/mount.html" as RelPath], {
      guards: [{
        path: "assets/shared.png" as RelPath,
        state: { kind: "file", contentHash: "sha256:shared" as ContentHash },
      }],
    }));
    value.emit(receipt("dependency-edit", null, ["assets/shared.png" as RelPath], { action: "ignore" }));

    expect(value.state("studio", projectId)).toMatchObject({ canUndo: true, undoBlocked: false });
    undoTop(value, "studio", "scenes/mount.html" as RelPath);
    expect(value.state("studio", projectId)).toMatchObject({ canRedo: false, redoBlocked: true });
  });

  it("keeps a redo reservation alive when only undo becomes blocked", () => {
    const value = history();
    attach(value);
    value.emit(receipt("target", "studio", ["packages/owned" as RelPath]));
    undoTop(value, "studio", "packages/owned" as RelPath);
    const begun = value.begin("studio", projectId, "redo");
    if (!begun.ok) throw new Error("expected redo reservation");

    value.emit(receipt("consumer", null, ["scenes/consumer.html" as RelPath], {
      action: "ignore",
      guards: [{ path: "packages/owned/index.js" as RelPath, state: { kind: "directory" } }],
    }));

    expect(value.state("studio", projectId)).toMatchObject({ busy: true, redoBlocked: false });
    expect(value.claimHistoryOperation(projectId, mutationOrigin("studio", "redo", {
      id: begun.value.operationId,
      targetReceiptId: begun.value.receipt.id,
    }))).toEqual({ ok: true });
  });

  it("blocks undo when the incoming mutation depends on an owned path", () => {
    const value = history();
    attach(value);
    value.emit(receipt("owned-package", "studio", ["packages/foo" as RelPath]));
    value.emit(receipt("consumer", null, ["scenes/consumer.html" as RelPath], {
      action: "ignore",
      guards: [{ path: "packages/foo/index.js" as RelPath, state: { kind: "directory" } }],
    }));

    expect(value.state("studio", projectId)).toMatchObject({ canUndo: false, undoBlocked: true });
  });

  it("does not invalidate a directory guard for child changes, but does for parent changes", () => {
    const value = history();
    attach(value);
    value.emit(receipt("directory-user", "studio", ["scenes/user.html" as RelPath], {
      guards: [{ path: "assets/library" as RelPath, state: { kind: "directory" } }],
    }));
    value.observeExternalChange(projectId, ["assets/library/child.png" as RelPath]);
    undoTop(value, "studio", "scenes/user.html" as RelPath);
    expect(value.state("studio", projectId)).toMatchObject({ canRedo: true, redoBlocked: false });

    value.observeExternalChange(projectId, ["assets" as RelPath]);
    expect(value.state("studio", projectId)).toMatchObject({ canRedo: false, redoBlocked: true });
  });

  it("keeps a blocked deep entry hidden until it reaches the top", () => {
    const value = history();
    attach(value);
    value.emit(receipt("deep", "studio", ["scenes/deep.html" as RelPath]));
    value.emit(receipt("top", "studio", ["scenes/top.html" as RelPath]));
    value.observeExternalChange(projectId, ["scenes/deep.html" as RelPath]);

    expect(value.state("studio", projectId)).toMatchObject({ canUndo: true, undoBlocked: false, nextUndoLabel: "label studio" });
    undoTop(value, "studio", "scenes/top.html" as RelPath);
    expect(value.state("studio", projectId)).toMatchObject({ canUndo: false, undoBlocked: true });
  });

  it("keeps a blocked deep redo entry hidden until the clean top redo is applied", () => {
    const value = history();
    attach(value);
    value.emit(receipt("redo-deep", "studio", ["scenes/redo-deep.html" as RelPath]));
    value.emit(receipt("redo-top", "studio", ["scenes/redo-top.html" as RelPath]));
    undoTop(value, "studio", "scenes/redo-top.html" as RelPath);
    undoTop(value, "studio", "scenes/redo-deep.html" as RelPath);
    value.observeExternalChange(projectId, ["scenes/redo-top.html" as RelPath]);

    expect(value.state("studio", projectId)).toMatchObject({ canRedo: true, redoBlocked: false });
    redoTop(value, "studio", "scenes/redo-deep.html" as RelPath);
    expect(value.state("studio", projectId)).toMatchObject({ canRedo: false, redoBlocked: true });
  });

  it("settles and blocks exactly the reserved direction on a synchronous conflict", () => {
    const value = history();
    attach(value);
    value.emit(receipt("target", "studio", ["scenes/target.html" as RelPath]));
    const begun = value.begin("studio", projectId, "undo");
    if (!begun.ok) throw new Error("expected undo reservation");
    const operation = { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id };
    const origin = mutationOrigin("studio", "undo", operation);

    value.blockHistoryOperation(projectId, origin, ["scenes/target.html" as RelPath]);
    value.cancel(operation.id);

    expect(value.state("studio", projectId)).toMatchObject({ busy: false, canUndo: false, undoBlocked: true });
  });
});
