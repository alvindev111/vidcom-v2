import { randomUUID } from "node:crypto";

import {
  err,
  ok,
  type EmitResult,
  type MutationObserverPort,
  type MutationOrigin,
  type MutationReadGuard,
  type MutationReceipt,
  type Result,
  type UndoContentPort,
  type UndoContentRef,
} from "@vidcom/core";
import { ErrorCode, type DomainError, type ProjectId, type RelPath } from "@vidcom/contracts";

type Direction = "undo" | "redo";
type BlockReason = "source-changed-externally" | "history-desync";

interface HistoryEntry {
  receipt: MutationReceipt;
  undoBlockedReason: BlockReason | null;
  redoBlockedReason: BlockReason | null;
  refsReleased: boolean;
}

interface HistoryOperation {
  id: string;
  direction: Direction;
  targetReceiptId: string;
  state: "pending" | "committing";
}

interface HistoryStack {
  sessionId: string;
  projectId: ProjectId;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  operation: HistoryOperation | null;
  clearDeferred: boolean;
}

interface Attachment {
  browserSessionId: string;
  projectId: ProjectId;
  generation: number;
  eventLeases: number;
  graceTimer: unknown | null;
  graceGeneration: number;
}

export interface MutationHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  depth: number;
  nextUndoLabel: string | null;
  nextRedoLabel: string | null;
  undoBlocked: boolean;
  redoBlocked: boolean;
  undoBlockedReason: string | null;
  redoBlockedReason: string | null;
}

export interface MutationHistoryOptions {
  operationId?: () => string;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (timer: unknown) => void;
}

const MAX_ENTRIES = 50;
const MAX_RETAINED_RECEIPT_IDS = 4_096;

/** Fixed-size insertion-ordered dedupe window for at-least-once receipt delivery. */
class BoundedReceiptIds {
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    if (!this.ids.delete(id)) return false;
    this.ids.add(id);
    return true;
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > MAX_RETAINED_RECEIPT_IDS) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  clear(): void {
    this.ids.clear();
  }

  get size(): number {
    return this.ids.size;
  }
}

function stackKey(sessionId: string, projectId: ProjectId): string {
  return `${sessionId}\u0000${projectId}`;
}

function pathSegments(path: RelPath): string[] {
  return path.split("/");
}

function isAncestorOrEqual(parent: RelPath, child: RelPath): boolean {
  const parentParts = pathSegments(parent);
  const childParts = pathSegments(child);
  return parentParts.length <= childParts.length
    && parentParts.every((part, index) => part === childParts[index]);
}

function ownedOverlap(left: readonly RelPath[], right: readonly RelPath[]): boolean {
  return left.some((leftPath) => right.some((rightPath) => (
    isAncestorOrEqual(leftPath, rightPath) || isAncestorOrEqual(rightPath, leftPath)
  )));
}

function invalidates(changed: readonly RelPath[], guards: readonly MutationReadGuard[]): boolean {
  return changed.some((changedPath) => guards.some((guard) => isAncestorOrEqual(changedPath, guard.path)));
}

function entry(receipt: MutationReceipt): HistoryEntry {
  return { receipt, undoBlockedReason: null, redoBlockedReason: null, refsReleased: false };
}

function selected(stack: HistoryStack, direction: Direction): HistoryEntry | undefined {
  const entries = direction === "undo" ? stack.undo : stack.redo;
  return entries.at(-1);
}

function operationFrom(origin: MutationOrigin): { id: string; targetReceiptId: string } | null {
  return origin.historyOperation;
}

function conflict(message: string): Result<never, DomainError> {
  return err({ code: ErrorCode.WriteConflict, message });
}

/**
 * Session-owned, in-memory undo history. All observer methods are synchronous and
 * non-throwing so a post-commit notification can never turn a committed write into
 * an application failure.
 */
export class MutationHistory implements MutationObserverPort {
  private readonly stacks = new Map<string, HistoryStack>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly seenReceiptIds = new BoundedReceiptIds();
  private readonly createOperationId: () => string;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (timer: unknown) => void;
  private nextAttachmentGeneration = 0;

  constructor(
    private readonly content: UndoContentPort,
    options: MutationHistoryOptions = {},
  ) {
    this.createOperationId = options.operationId ?? randomUUID;
    this.schedule = options.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    });
    this.cancelScheduled = options.cancelScheduled ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  attach(browserSessionId: string, sessionId: string, projectId: ProjectId): void {
    const current = this.attachments.get(sessionId);
    if (current) {
      if (current.browserSessionId === browserSessionId && current.projectId === projectId) {
        this.cancelGrace(current);
      }
      return;
    }
    this.attachments.set(sessionId, {
      browserSessionId,
      projectId,
      generation: ++this.nextAttachmentGeneration,
      eventLeases: 0,
      graceTimer: null,
      graceGeneration: 0,
    });
    this.getOrCreateStack(sessionId, projectId);
  }

  detach(browserSessionId: string, sessionId: string, projectId: ProjectId): void {
    const current = this.attachments.get(sessionId);
    if (!current || current.browserSessionId !== browserSessionId || current.projectId !== projectId) return;
    this.cancelGrace(current);
    this.attachments.delete(sessionId);
    this.clear(sessionId, projectId);
  }

  isAttached(browserSessionId: string, sessionId: string, projectId: ProjectId): boolean {
    const current = this.attachments.get(sessionId);
    return current?.browserSessionId === browserSessionId && current.projectId === projectId;
  }

  openEventLease(browserSessionId: string, sessionId: string, projectId: ProjectId): number | null {
    const current = this.attachments.get(sessionId);
    if (!current || current.browserSessionId !== browserSessionId || current.projectId !== projectId) return null;
    this.cancelGrace(current);
    current.eventLeases += 1;
    return current.generation;
  }

  closeEventLease(
    browserSessionId: string,
    sessionId: string,
    projectId: ProjectId,
    generation: number,
  ): void {
    const current = this.attachments.get(sessionId);
    if (!current || current.browserSessionId !== browserSessionId || current.projectId !== projectId
      || current.generation !== generation || current.eventLeases === 0) return;
    current.eventLeases -= 1;
    if (current.eventLeases > 0 || current.graceTimer !== null) return;
    const scheduledGeneration = current.generation;
    const graceGeneration = ++current.graceGeneration;
    current.graceTimer = this.schedule(() => {
      const latest = this.attachments.get(sessionId);
      if (latest !== current || latest.generation !== scheduledGeneration
        || latest.graceGeneration !== graceGeneration || latest.eventLeases > 0) return;
      latest.graceTimer = null;
      this.attachments.delete(sessionId);
      this.clear(sessionId, projectId);
    }, 30_000);
  }

  begin(
    sessionId: string,
    projectId: ProjectId,
    direction: Direction,
  ): Result<{ operationId: string; receipt: MutationReceipt }, DomainError> {
    const stack = this.stackIfAttached(sessionId, projectId);
    if (!stack) return conflict("studio session is not attached to this project");
    if (stack.operation) return conflict("a history operation is already in progress");
    const target = selected(stack, direction);
    if (!target) return conflict(`there is no ${direction} operation available`);
    const blocked = direction === "undo" ? target.undoBlockedReason : target.redoBlockedReason;
    if (blocked) return conflict(`${direction} is blocked because the source changed`);
    const operationId = this.createOperationId();
    stack.operation = { id: operationId, direction, targetReceiptId: target.receipt.id, state: "pending" };
    return ok({ operationId, receipt: target.receipt });
  }

  cancel(operationId: string): void {
    try {
      for (const stack of this.stacks.values()) {
        if (stack.operation?.id !== operationId || stack.operation.state === "committing") continue;
        stack.operation = null;
        if (stack.clearDeferred) this.clearStack(stack);
        return;
      }
    } catch {}
  }

  claimHistoryOperation(projectId: ProjectId, origin: MutationOrigin): EmitResult {
    try {
      const stack = this.stackForOrigin(projectId, origin);
      const requested = operationFrom(origin);
      if (!stack || !requested || !this.isInverse(origin)) return { ok: false, reason: "history reservation is invalid" };
      const operation = stack.operation;
      if (!operation || operation.state !== "pending" || operation.id !== requested.id
        || operation.targetReceiptId !== requested.targetReceiptId || operation.direction !== origin.historyAction) {
        return { ok: false, reason: "history reservation is stale" };
      }
      const target = selected(stack, operation.direction);
      const blocked = operation.direction === "undo" ? target?.undoBlockedReason : target?.redoBlockedReason;
      if (!target || target.receipt.id !== operation.targetReceiptId || blocked) {
        stack.operation = null;
        return { ok: false, reason: blocked ? "history target is blocked" : "history target changed" };
      }
      operation.state = "committing";
      return { ok: true };
    } catch {
      return { ok: false, reason: "history reservation could not be claimed" };
    }
  }

  abortHistoryOperation(projectId: ProjectId, origin: MutationOrigin): void {
    try {
      const stack = this.existingStackForOrigin(projectId, origin);
      if (!stack || !this.matchesOperation(stack, origin)) return;
      stack.operation = null;
      if (stack.clearDeferred) this.clearStack(stack);
    } catch {}
  }

  blockHistoryOperation(projectId: ProjectId, origin: MutationOrigin, paths: RelPath[]): void {
    try {
      void paths;
      const stack = this.existingStackForOrigin(projectId, origin);
      if (!stack || !this.matchesOperation(stack, origin)) return;
      const operation = stack.operation!;
      const target = selected(stack, operation.direction);
      if (target?.receipt.id === operation.targetReceiptId) {
        if (operation.direction === "undo") target.undoBlockedReason = "source-changed-externally";
        else target.redoBlockedReason = "source-changed-externally";
      }
      stack.operation = null;
      if (stack.clearDeferred) this.clearStack(stack);
    } catch {}
  }

  emit(receipt: MutationReceipt): EmitResult {
    try {
      if (this.seenReceiptIds.has(receipt.id)) {
        this.releaseReceipt(receipt);
        return { ok: true };
      }

      if (this.isInverse(receipt.origin)) {
        const result = this.emitInverse(receipt);
        if (result.ok) this.seenReceiptIds.add(receipt.id);
        return result;
      }

      this.seenReceiptIds.add(receipt.id);
      const owner = this.recordOwner(receipt);
      this.applyIncomingBarrier(receipt, owner);
      if (!owner) {
        this.releaseReceipt(receipt);
        return { ok: true };
      }

      for (const redo of owner.redo) this.releaseEntry(redo);
      owner.redo = [];
      owner.undo.push(entry(receipt));
      while (owner.undo.length > MAX_ENTRIES) {
        const evicted = owner.undo.shift();
        if (evicted) this.releaseEntry(evicted);
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: "history receipt could not be applied" };
    }
  }

  observeExternalChange(projectId: ProjectId, paths: RelPath[]): void {
    try {
      for (const stack of this.projectStacks(projectId)) {
        for (const historyEntry of [...stack.undo, ...stack.redo]) {
          const overlap = ownedOverlap(historyEntry.receipt.paths, paths);
          if (overlap) historyEntry.undoBlockedReason = "source-changed-externally";
          if (overlap || invalidates(paths, historyEntry.receipt.readGuards)) {
            historyEntry.redoBlockedReason = "source-changed-externally";
          }
        }
        this.cancelBlockedPending(stack);
      }
    } catch {}
  }

  invalidateProject(projectId: ProjectId, reason: "history-desync"): void {
    try {
      void reason;
      for (const stack of this.projectStacks(projectId)) {
        for (const historyEntry of [...stack.undo, ...stack.redo]) {
          historyEntry.undoBlockedReason = "history-desync";
          historyEntry.redoBlockedReason = "history-desync";
          this.releaseEntry(historyEntry);
        }
        stack.operation = null;
        if (stack.clearDeferred) this.clearStack(stack);
      }
    } catch {}
  }

  state(sessionId: string, projectId: ProjectId): MutationHistoryState {
    const stack = this.stacks.get(stackKey(sessionId, projectId));
    const undo = stack?.undo.at(-1);
    const redo = stack?.redo.at(-1);
    return {
      canUndo: undo !== undefined && undo.undoBlockedReason === null,
      canRedo: redo !== undefined && redo.redoBlockedReason === null,
      busy: stack?.operation !== null && stack?.operation !== undefined,
      depth: stack?.undo.length ?? 0,
      nextUndoLabel: undo?.receipt.origin.label ?? null,
      nextRedoLabel: redo?.receipt.origin.label ?? null,
      undoBlocked: undo?.undoBlockedReason !== null && undo?.undoBlockedReason !== undefined,
      redoBlocked: redo?.redoBlockedReason !== null && redo?.redoBlockedReason !== undefined,
      undoBlockedReason: undo?.undoBlockedReason ?? null,
      redoBlockedReason: redo?.redoBlockedReason ?? null,
    };
  }

  /** Bounded counters emitted by lifecycle soak tests without exposing receipt identities. */
  diagnosticState(): { retainedReceiptIds: number; undoEntries: number; redoEntries: number } {
    let undoEntries = 0;
    let redoEntries = 0;
    for (const stack of this.stacks.values()) {
      undoEntries += stack.undo.length;
      redoEntries += stack.redo.length;
    }
    return { retainedReceiptIds: this.seenReceiptIds.size, undoEntries, redoEntries };
  }

  clear(sessionId: string, projectId?: ProjectId): void {
    try {
      for (const stack of this.stacks.values()) {
        if (stack.sessionId !== sessionId || (projectId !== undefined && stack.projectId !== projectId)) continue;
        if (stack.operation?.state === "committing") {
          stack.clearDeferred = true;
          continue;
        }
        stack.operation = null;
        this.clearStack(stack);
      }
    } catch {}
  }

  dispose(): void {
    try {
      for (const attachment of this.attachments.values()) this.cancelGrace(attachment);
      this.attachments.clear();
      for (const stack of this.stacks.values()) {
        if (stack.operation?.state === "committing") stack.clearDeferred = true;
        else this.clearStack(stack);
      }
      this.seenReceiptIds.clear();
    } catch {}
  }

  private getOrCreateStack(sessionId: string, projectId: ProjectId): HistoryStack {
    const key = stackKey(sessionId, projectId);
    const current = this.stacks.get(key);
    if (current) return current;
    const created: HistoryStack = {
      sessionId,
      projectId,
      undo: [],
      redo: [],
      operation: null,
      clearDeferred: false,
    };
    this.stacks.set(key, created);
    return created;
  }

  private stackIfAttached(sessionId: string, projectId: ProjectId): HistoryStack | null {
    const attachment = this.attachments.get(sessionId);
    if (!attachment || attachment.projectId !== projectId) return null;
    return this.getOrCreateStack(sessionId, projectId);
  }

  private stackForOrigin(projectId: ProjectId, origin: MutationOrigin): HistoryStack | null {
    if (origin.sessionId === null) return null;
    return this.stackIfAttached(origin.sessionId, projectId);
  }

  private existingStackForOrigin(projectId: ProjectId, origin: MutationOrigin): HistoryStack | null {
    if (origin.sessionId === null) return null;
    return this.stacks.get(stackKey(origin.sessionId, projectId)) ?? null;
  }

  private recordOwner(receipt: MutationReceipt): HistoryStack | null {
    if (receipt.origin.historyAction !== "record" || !receipt.undoable) return null;
    return this.stackForOrigin(receipt.projectId, receipt.origin);
  }

  private isInverse(origin: MutationOrigin): origin is MutationOrigin & { historyAction: Direction } {
    return origin.historyAction === "undo" || origin.historyAction === "redo";
  }

  private matchesOperation(stack: HistoryStack, origin: MutationOrigin): boolean {
    const requested = operationFrom(origin);
    return requested !== null && stack.operation?.id === requested.id
      && stack.operation.targetReceiptId === requested.targetReceiptId;
  }

  private emitInverse(receipt: MutationReceipt): EmitResult {
    const owner = this.existingStackForOrigin(receipt.projectId, receipt.origin);
    if (!owner || !this.matchesOperation(owner, receipt.origin) || owner.operation?.state !== "committing") {
      return { ok: false, reason: "history reservation was not claimed" };
    }
    const operation = owner.operation;
    const source = operation.direction === "undo" ? owner.undo : owner.redo;
    const destination = operation.direction === "undo" ? owner.redo : owner.undo;
    const target = source.at(-1);
    if (!target || target.receipt.id !== operation.targetReceiptId) {
      return { ok: false, reason: "history target changed before receipt delivery" };
    }

    this.applyIncomingBarrier(receipt, owner);
    source.pop();
    destination.push(target);
    owner.operation = null;
    this.releaseReceipt(receipt);
    if (owner.clearDeferred) this.clearStack(owner);
    return { ok: true };
  }

  private applyIncomingBarrier(receipt: MutationReceipt, owner: HistoryStack | null): void {
    for (const stack of this.projectStacks(receipt.projectId)) {
      if (stack === owner) continue;
      for (const historyEntry of [...stack.undo, ...stack.redo]) {
        const overlap = ownedOverlap(historyEntry.receipt.paths, receipt.paths);
        if (overlap || invalidates(historyEntry.receipt.paths, receipt.readGuards)) {
          historyEntry.undoBlockedReason = "source-changed-externally";
        }
        if (overlap || invalidates(receipt.paths, historyEntry.receipt.readGuards)) {
          historyEntry.redoBlockedReason = "source-changed-externally";
        }
      }
      this.cancelBlockedPending(stack);
    }
  }

  private cancelBlockedPending(stack: HistoryStack): void {
    const operation = stack.operation;
    if (!operation || operation.state !== "pending") return;
    const target = selected(stack, operation.direction);
    const blocked = operation.direction === "undo" ? target?.undoBlockedReason : target?.redoBlockedReason;
    if (!target || target.receipt.id !== operation.targetReceiptId || blocked) stack.operation = null;
  }

  private projectStacks(projectId: ProjectId): HistoryStack[] {
    return [...this.stacks.values()].filter((stack) => stack.projectId === projectId);
  }

  private clearStack(stack: HistoryStack): void {
    for (const historyEntry of [...stack.undo, ...stack.redo]) this.releaseEntry(historyEntry);
    stack.undo = [];
    stack.redo = [];
    stack.operation = null;
    stack.clearDeferred = false;
  }

  private releaseReceipt(receipt: MutationReceipt): void {
    const refs: UndoContentRef[] = [];
    for (const step of receipt.steps) {
      if (step.kind !== "file" || !step.undoable) continue;
      if (step.beforeContent) refs.push(step.beforeContent);
      if (step.afterContent) refs.push(step.afterContent);
    }
    if (refs.length > 0) {
      try { this.content.release(refs); } catch {}
    }
  }

  private releaseEntry(historyEntry: HistoryEntry): void {
    if (historyEntry.refsReleased) return;
    historyEntry.refsReleased = true;
    this.releaseReceipt(historyEntry.receipt);
  }

  private cancelGrace(attachment: Attachment): void {
    if (attachment.graceTimer === null) return;
    try { this.cancelScheduled(attachment.graceTimer); } catch {}
    attachment.graceGeneration += 1;
    attachment.graceTimer = null;
  }
}
