// @vitest-environment node

import { describe, expect, it } from "vitest";

import type {
  MutationOrigin,
  MutationReceipt,
  UndoContentPort,
  UndoContentRef,
} from "@vidcom/core";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { MutationHistory } from "../../packages/server/src/service/mutation-history";

const projectId = "project_history" as ProjectId;

function origin(
  sessionId: string | null,
  historyAction: MutationOrigin["historyAction"] = "record",
  operation: MutationOrigin["historyOperation"] = null,
): MutationOrigin {
  return {
    kind: sessionId === null ? "mcp" : "ui",
    sessionId,
    label: sessionId === null ? null : `edit ${sessionId}`,
    historyAction,
    historyOperation: operation,
  };
}

function receipt(
  id: string,
  sessionId: string | null,
  path = `scenes/${id}.html` as RelPath,
  historyAction: MutationOrigin["historyAction"] = "record",
  operation: MutationOrigin["historyOperation"] = null,
): MutationReceipt {
  return {
    id,
    projectId,
    origin: origin(sessionId, historyAction, operation),
    steps: [],
    paths: [path],
    readGuards: [],
    projectRevision: 1,
    at: "2026-08-18T00:00:00.000Z",
    undoable: true,
  };
}

function guardedReceipt(id: string, sessionId: string, path: RelPath, dependency: RelPath): MutationReceipt {
  const value = receipt(id, sessionId, path);
  value.readGuards = [{
    path: dependency,
    state: { kind: "file", contentHash: "sha256:dependency" as ContentHash },
  }];
  return value;
}

function contentPort(released: UndoContentRef[][]): UndoContentPort {
  return {
    async retainBytes() { throw new Error("not used"); },
    async retainFile() { throw new Error("not used"); },
    async resolve() { throw new Error("not used"); },
    release(refs) { released.push([...refs]); },
  };
}

function attached(history: MutationHistory, browser: string, studio: string): void {
  history.attach(browser, studio, projectId);
}

describe("MutationHistory", () => {
  it("keys history by studio session, caps undo at 50, and cuts the redo branch", () => {
    const history = new MutationHistory(contentPort([]), { operationId: () => "operation_fixed" });
    attached(history, "browser-a", "studio-a");
    attached(history, "browser-b", "studio-b");

    for (let index = 0; index < 51; index += 1) {
      expect(history.emit(receipt(`receipt-${index}`, "studio-a"))).toEqual({ ok: true });
    }
    expect(history.state("studio-a", projectId)).toMatchObject({ depth: 50, canUndo: true, canRedo: false });
    expect(history.state("studio-b", projectId)).toMatchObject({ depth: 0, canUndo: false, canRedo: false });

    const begun = history.begin("studio-a", projectId, "undo");
    expect(begun.ok && begun.value.receipt.id).toBe("receipt-50");
    if (!begun.ok) throw new Error("expected undo reservation");
    const undoOrigin = origin("studio-a", "undo", {
      id: begun.value.operationId,
      targetReceiptId: begun.value.receipt.id,
    });
    expect(history.claimHistoryOperation(projectId, undoOrigin)).toEqual({ ok: true });
    expect(history.emit(receipt("inverse-50", "studio-a", "scenes/receipt-50.html" as RelPath, "undo", undoOrigin.historyOperation))).toEqual({ ok: true });
    expect(history.state("studio-a", projectId)).toMatchObject({ depth: 49, canRedo: true });

    expect(history.emit(receipt("receipt-new", "studio-a"))).toEqual({ ok: true });
    expect(history.state("studio-a", projectId)).toMatchObject({ depth: 50, canRedo: false });
  });

  it("permits only one reservation and atomically moves the original receipt after claim", () => {
    const released: UndoContentRef[][] = [];
    const history = new MutationHistory(contentPort(released), { operationId: () => "operation-1" });
    attached(history, "browser", "studio");
    history.emit(receipt("original", "studio"));

    const begun = history.begin("studio", projectId, "undo");
    expect(begun).toMatchObject({ ok: true, value: { operationId: "operation-1" } });
    expect(history.begin("studio", projectId, "undo")).toMatchObject({
      ok: false,
      error: { code: "write_conflict" },
    });
    if (!begun.ok) throw new Error("expected reservation");
    const operation = { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id };
    const undoOrigin = origin("studio", "undo", operation);
    expect(history.claimHistoryOperation(projectId, undoOrigin)).toEqual({ ok: true });

    const inverseRef: UndoContentRef = {
      kind: "inline",
      bytes: new Uint8Array([1]),
      encoding: "binary",
      contentHash: "sha256:inverse" as ContentHash,
    };
    const inverse = receipt("inverse", "studio", undefined, "undo", operation);
    inverse.steps = [{
      kind: "file",
      undoable: true,
      path: inverse.paths[0]!,
      beforeContent: inverseRef,
      afterContent: null,
      fromHash: null,
      toHash: null,
    }];
    expect(history.emit(inverse)).toEqual({ ok: true });
    expect(history.state("studio", projectId)).toMatchObject({
      busy: false,
      depth: 0,
      canUndo: false,
      canRedo: true,
      nextRedoLabel: "edit studio",
    });
    expect(released).toEqual([[inverseRef]]);
  });

  it("aborts a claimed operation without changing either stack", () => {
    const history = new MutationHistory(contentPort([]), { operationId: () => "operation-abort" });
    attached(history, "browser", "studio");
    history.emit(receipt("original", "studio"));
    const begun = history.begin("studio", projectId, "undo");
    if (!begun.ok) throw new Error("expected reservation");
    const undoOrigin = origin("studio", "undo", {
      id: begun.value.operationId,
      targetReceiptId: begun.value.receipt.id,
    });
    expect(history.claimHistoryOperation(projectId, undoOrigin)).toEqual({ ok: true });

    history.abortHistoryOperation(projectId, undoOrigin);

    expect(history.state("studio", projectId)).toMatchObject({
      busy: false,
      depth: 1,
      canUndo: true,
      canRedo: false,
      nextUndoLabel: "edit studio",
    });
  });

  it("rechecks the selected direction at claim time", () => {
    const history = new MutationHistory(contentPort([]), { operationId: () => "operation-blocked" });
    attached(history, "browser", "studio");
    history.emit(receipt("original", "studio", "scenes/original.html" as RelPath));
    const begun = history.begin("studio", projectId, "undo");
    if (!begun.ok) throw new Error("expected reservation");
    history.observeExternalChange(projectId, ["scenes/original.html" as RelPath]);

    expect(history.claimHistoryOperation(projectId, origin("studio", "undo", {
      id: begun.value.operationId,
      targetReceiptId: begun.value.receipt.id,
    }))).toMatchObject({ ok: false });
    expect(history.state("studio", projectId)).toMatchObject({ busy: false, undoBlocked: true });
  });

  it("keeps an undo reservation alive when only redo becomes blocked", () => {
    const history = new MutationHistory(contentPort([]), { operationId: () => "operation-direction" });
    attached(history, "browser", "studio");
    history.emit(guardedReceipt(
      "original",
      "studio",
      "scenes/original.html" as RelPath,
      "assets/shared.png" as RelPath,
    ));
    const begun = history.begin("studio", projectId, "undo");
    if (!begun.ok) throw new Error("expected reservation");

    history.emit(receipt(
      "external-dependency-edit",
      null,
      "assets/shared.png" as RelPath,
      "ignore",
    ));

    expect(history.state("studio", projectId)).toMatchObject({ busy: true, undoBlocked: false, redoBlocked: false });
    expect(history.claimHistoryOperation(projectId, origin("studio", "undo", {
      id: begun.value.operationId,
      targetReceiptId: begun.value.receipt.id,
    }))).toEqual({ ok: true });
  });

  it("rejects a reservation when a same-stack record changes the top receipt", () => {
    let nextOperation = 0;
    const history = new MutationHistory(contentPort([]), { operationId: () => `operation-top-${++nextOperation}` });
    attached(history, "browser", "studio");
    history.emit(receipt("original", "studio"));
    const begun = history.begin("studio", projectId, "undo");
    if (!begun.ok) throw new Error("expected reservation");

    history.emit(receipt("new-top", "studio", "scenes/new-top.html" as RelPath));

    expect(history.claimHistoryOperation(projectId, origin("studio", "undo", {
      id: begun.value.operationId,
      targetReceiptId: begun.value.receipt.id,
    }))).toMatchObject({ ok: false });
    expect(history.state("studio", projectId)).toMatchObject({ busy: false, depth: 2 });
  });

  it("does not self-barrier the owner on inverse emit but barriers another studio", () => {
    let nextOperation = 0;
    const history = new MutationHistory(contentPort([]), { operationId: () => `operation-${++nextOperation}` });
    attached(history, "browser-a", "studio-a");
    attached(history, "browser-b", "studio-b");
    history.emit(receipt("a-older", "studio-a", "scenes/older.html" as RelPath));
    history.emit(receipt("b-entry", "studio-b", "shared/scene.html" as RelPath));
    history.emit(receipt("a-target", "studio-a", "scenes/target.html" as RelPath));
    const begun = history.begin("studio-a", projectId, "undo");
    if (!begun.ok) throw new Error("expected reservation");
    const operation = { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id };
    const undoOrigin = origin("studio-a", "undo", operation);
    expect(history.claimHistoryOperation(projectId, undoOrigin)).toEqual({ ok: true });
    expect(history.emit(receipt("a-inverse", "studio-a", "shared/scene.html" as RelPath, "undo", operation))).toEqual({ ok: true });

    expect(history.state("studio-a", projectId)).toMatchObject({ undoBlocked: false, canUndo: true });
    expect(history.state("studio-b", projectId)).toMatchObject({ undoBlocked: true, canUndo: false });
  });

  it("defers clear while a claimed operation is committing", () => {
    const history = new MutationHistory(contentPort([]), { operationId: () => "operation-clear" });
    attached(history, "browser", "studio");
    history.emit(receipt("original", "studio"));
    const begun = history.begin("studio", projectId, "undo");
    if (!begun.ok) throw new Error("expected reservation");
    const operation = { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id };
    const undoOrigin = origin("studio", "undo", operation);
    expect(history.claimHistoryOperation(projectId, undoOrigin)).toEqual({ ok: true });

    history.clear("studio", projectId);
    expect(history.state("studio", projectId)).toMatchObject({ busy: true, depth: 1 });
    history.abortHistoryOperation(projectId, undoOrigin);
    expect(history.state("studio", projectId)).toMatchObject({ busy: false, depth: 0, canUndo: false });
  });
});
