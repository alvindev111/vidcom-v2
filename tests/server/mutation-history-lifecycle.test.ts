// @vitest-environment node

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import type {
  MutationOrigin,
  MutationReceipt,
  UndoContentPort,
  UndoContentRef,
} from "@vidcom/core";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { MutationHistory } from "../../packages/server/src/service/mutation-history";

const projectId = "project_lifecycle" as ProjectId;

function objectRef(id: string): UndoContentRef {
  return { kind: "object", contentHash: `sha256:${id}` as ContentHash, encoding: "binary" };
}

function origin(
  studio: string | null,
  action: MutationOrigin["historyAction"] = "record",
  operation: MutationOrigin["historyOperation"] = null,
): MutationOrigin {
  return {
    kind: studio === null ? "system" : "ui",
    sessionId: studio,
    label: studio === null ? null : `edit ${studio}`,
    historyAction: action,
    historyOperation: operation,
  };
}

function receipt(
  id: string,
  studio: string | null,
  ref: UndoContentRef,
  options: {
    path?: RelPath;
    action?: MutationOrigin["historyAction"];
    operation?: MutationOrigin["historyOperation"];
  } = {},
): MutationReceipt {
  const path = options.path ?? `scenes/${id}.html` as RelPath;
  return {
    id,
    projectId,
    origin: origin(studio, options.action, options.operation),
    steps: [{
      kind: "file",
      undoable: true,
      path,
      beforeContent: ref,
      afterContent: null,
      fromHash: null,
      toHash: ref.contentHash,
    }],
    paths: [path],
    readGuards: [],
    projectRevision: 1,
    at: "2026-08-18T00:00:00.000Z",
    undoable: true,
  };
}

function fixture(options: ConstructorParameters<typeof MutationHistory>[1] = {}) {
  const releases = new Map<string, number>();
  const content: UndoContentPort = {
    async retainBytes() { throw new Error("not used"); },
    async retainFile() { throw new Error("not used"); },
    async resolve() { throw new Error("not used"); },
    release(refs) {
      for (const ref of refs) {
        releases.set(ref.contentHash, (releases.get(ref.contentHash) ?? 0) + 1);
      }
    },
  };
  return { history: new MutationHistory(content, options), releases };
}

function releaseCount(releases: Map<string, number>, ref: UndoContentRef): number {
  return releases.get(ref.contentHash) ?? 0;
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0) reject(new Error(output.stderr || output.stdout || `${command} exited ${code}`));
      else resolve(output);
    });
  });
}

function attach(history: MutationHistory, studio = "studio", browser = `browser-${studio}`): void {
  history.attach(browser, studio, projectId);
}

function claimUndo(history: MutationHistory, studio = "studio") {
  const begun = history.begin(studio, projectId, "undo");
  if (!begun.ok) throw new Error("expected undo reservation");
  const operation = { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id };
  const undoOrigin = origin(studio, "undo", operation);
  expect(history.claimHistoryOperation(projectId, undoOrigin)).toEqual({ ok: true });
  return { operation, undoOrigin };
}

describe("MutationHistory lifecycle and ref ownership", () => {
  it("does not resurrect unattached UI or startup-recovery stacks and releases both receipts", () => {
    const { history, releases } = fixture();
    attach(history, "live");
    history.emit(receipt("live-entry", "live", objectRef("live"), { path: "scenes/shared.html" as RelPath }));
    const staleRef = objectRef("stale");
    const recoveryRef = objectRef("recovery");

    expect(history.emit(receipt("stale-ui", "stale", staleRef, { path: "scenes/shared.html" as RelPath }))).toEqual({ ok: true });
    expect(history.emit(receipt("startup-recovery", null, recoveryRef, { path: "scenes/shared.html" as RelPath, action: "ignore" }))).toEqual({ ok: true });

    expect(history.state("stale", projectId)).toMatchObject({ depth: 0, canUndo: false });
    expect(history.state("live", projectId)).toMatchObject({ depth: 1, undoBlocked: true });
    expect(releaseCount(releases, staleRef)).toBe(1);
    expect(releaseCount(releases, recoveryRef)).toBe(1);
  });

  it("releases each duplicate, eviction, branch-cut, inverse and clear ownership exactly once", () => {
    let operationId = 0;
    const { history, releases } = fixture({ operationId: () => `operation-${++operationId}` });
    attach(history);
    const refs = Array.from({ length: 51 }, (_, index) => objectRef(`record-${index}`));
    refs.forEach((ref, index) => history.emit(receipt(`record-${index}`, "studio", ref)));
    expect(releaseCount(releases, refs[0]!)).toBe(1);

    history.emit(receipt("record-50", "studio", refs[50]!));
    expect(releaseCount(releases, refs[50]!)).toBe(1);

    const { operation } = claimUndo(history);
    const inverseRef = objectRef("inverse");
    history.emit(receipt("inverse", "studio", inverseRef, {
      action: "undo",
      operation,
      path: "scenes/record-50.html" as RelPath,
    }));
    expect(releaseCount(releases, inverseRef)).toBe(1);

    const branchRef = objectRef("branch");
    history.emit(receipt("branch", "studio", branchRef));
    expect(releaseCount(releases, refs[50]!)).toBe(2);
    history.clear("studio", projectId);

    for (const [index, ref] of refs.entries()) {
      expect(releaseCount(releases, ref)).toBe(index === 50 ? 2 : 1);
    }
    expect(releaseCount(releases, inverseRef)).toBe(1);
    expect(releaseCount(releases, branchRef)).toBe(1);
  });

  it("lets a claimed inverse settle after explicit detach, then applies deferred clear", () => {
    const { history, releases } = fixture({ operationId: () => "operation-detach" });
    attach(history);
    const originalRef = objectRef("detach-original");
    history.emit(receipt("original", "studio", originalRef));
    const { operation } = claimUndo(history);

    history.detach("browser-studio", "studio", projectId);
    expect(history.state("studio", projectId)).toMatchObject({ busy: true, depth: 1 });
    const inverseRef = objectRef("detach-inverse");
    expect(history.emit(receipt("inverse", "studio", inverseRef, { action: "undo", operation }))).toEqual({ ok: true });

    expect(history.state("studio", projectId)).toMatchObject({ busy: false, depth: 0 });
    expect(releaseCount(releases, originalRef)).toBe(1);
    expect(releaseCount(releases, inverseRef)).toBe(1);
  });

  it("lets abort settle a claimed operation after detach without leaking refs", () => {
    const { history, releases } = fixture({ operationId: () => "operation-abort-detach" });
    attach(history);
    const originalRef = objectRef("abort-original");
    history.emit(receipt("original", "studio", originalRef));
    const { undoOrigin } = claimUndo(history);

    history.detach("browser-studio", "studio", projectId);
    history.abortHistoryOperation(projectId, undoOrigin);

    expect(history.state("studio", projectId)).toMatchObject({ busy: false, depth: 0 });
    expect(releaseCount(releases, originalRef)).toBe(1);
  });

  it("counts overlapping SSE leases and detaches only after the final 30-second grace", () => {
    type Timer = { callback: () => void; delay: number; cancelled: boolean };
    const timers: Timer[] = [];
    const { history, releases } = fixture({
      schedule: (callback, delay) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      cancelScheduled: (timer) => { (timer as Timer).cancelled = true; },
    });
    attach(history);
    const owned = objectRef("lease-owned");
    history.emit(receipt("owned", "studio", owned));

    const generation = history.openEventLease("browser-studio", "studio", projectId);
    expect(generation).not.toBeNull();
    expect(history.openEventLease("browser-studio", "studio", projectId)).toBe(generation);
    history.closeEventLease("browser-studio", "studio", projectId, generation!);
    expect(timers).toHaveLength(0);
    history.closeEventLease("browser-studio", "studio", projectId, generation!);
    expect(timers.at(-1)).toMatchObject({ delay: 30_000, cancelled: false });

    expect(history.openEventLease("browser-studio", "studio", projectId)).toBe(generation);
    expect(timers.at(-1)?.cancelled).toBe(true);
    history.closeEventLease("browser-studio", "studio", projectId, generation!);
    const finalTimer = timers.at(-1)!;
    timers[0]!.callback();
    expect(history.isAttached("browser-studio", "studio", projectId)).toBe(true);
    finalTimer.callback();

    expect(history.isAttached("browser-studio", "studio", projectId)).toBe(false);
    expect(history.state("studio", projectId)).toMatchObject({ depth: 0, busy: false });
    expect(releaseCount(releases, owned)).toBe(1);
  });

  it("revokes explicit detach immediately and requires POST attach before SSE can reopen", () => {
    const { history } = fixture();
    attach(history);
    expect(history.isAttached("browser-studio", "studio", projectId)).toBe(true);

    history.detach("browser-studio", "studio", projectId);

    expect(history.openEventLease("browser-studio", "studio", projectId)).toBeNull();
    history.attach("browser-studio", "studio", projectId);
    expect(history.openEventLease("browser-studio", "studio", projectId)).not.toBeNull();
    expect(history.state("studio", projectId)).toMatchObject({ depth: 0 });
  });

  it("ignores a stale grace callback from an explicitly revoked attachment generation", () => {
    const callbacks: Array<() => void> = [];
    const { history } = fixture({
      schedule: (callback) => {
        callbacks.push(callback);
        return callback;
      },
      cancelScheduled() {},
    });
    attach(history);
    const generation = history.openEventLease("browser-studio", "studio", projectId);
    history.closeEventLease("browser-studio", "studio", projectId, generation!);
    history.detach("browser-studio", "studio", projectId);
    history.attach("browser-studio", "studio", projectId);

    callbacks[0]!();

    expect(history.isAttached("browser-studio", "studio", projectId)).toBe(true);
  });

  it("ignores a stale SSE close from the attachment generation before explicit detach", () => {
    type Timer = { callback: () => void; delay: number };
    const timers: Timer[] = [];
    const { history } = fixture({
      schedule: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
    });
    attach(history);
    const oldGeneration = history.openEventLease("browser-studio", "studio", projectId);
    expect(oldGeneration).not.toBeNull();

    history.detach("browser-studio", "studio", projectId);
    history.attach("browser-studio", "studio", projectId);
    const newGeneration = history.openEventLease("browser-studio", "studio", projectId);
    expect(newGeneration).not.toBe(oldGeneration);

    history.closeEventLease("browser-studio", "studio", projectId, oldGeneration!);
    expect(timers).toHaveLength(0);
    expect(history.isAttached("browser-studio", "studio", projectId)).toBe(true);

    history.closeEventLease("browser-studio", "studio", projectId, newGeneration!);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ delay: 30_000 });
  });

  it("settles every reservation, blocks the project and releases refs on history desync", () => {
    const { history, releases } = fixture({ operationId: () => "operation-desync" });
    attach(history);
    const owned = objectRef("desync-owned");
    history.emit(receipt("owned", "studio", owned));
    const { undoOrigin } = claimUndo(history);

    history.invalidateProject(projectId, "history-desync");

    expect(history.state("studio", projectId)).toMatchObject({ busy: false, depth: 1, undoBlocked: true });
    expect(releaseCount(releases, owned)).toBe(1);
    history.abortHistoryOperation(projectId, undoOrigin);
    history.clear("studio", projectId);
    expect(releaseCount(releases, owned)).toBe(1);
  });

  it("releases every session stack on workspace disposal", () => {
    const { history, releases } = fixture();
    attach(history, "studio-a");
    attach(history, "studio-b");
    const first = objectRef("dispose-a");
    const second = objectRef("dispose-b");
    history.emit(receipt("dispose-a", "studio-a", first));
    history.emit(receipt("dispose-b", "studio-b", second));

    history.dispose();

    expect(history.isAttached("browser-studio-a", "studio-a", projectId)).toBe(false);
    expect(history.isAttached("browser-studio-b", "studio-b", projectId)).toBe(false);
    expect(releaseCount(releases, first)).toBe(1);
    expect(releaseCount(releases, second)).toBe(1);
    expect(history.diagnosticState()).toEqual({ retainedReceiptIds: 0, undoEntries: 0, redoEntries: 0 });
  });

  it("bounds receipt dedupe and releases every retained ref across a 100k-receipt soak", { timeout: 30_000 }, async () => {
    const support = new URL("./support/", import.meta.url);
    const loader = new URL("workspace-typescript-loader.mjs", support);
    const worker = new URL("mutation-history-lifecycle-worker.ts", support);
    const { stdout } = await run(process.execPath, [
      "--expose-gc",
      "--experimental-transform-types",
      "--input-type=module",
      "--eval", [
        'import { register } from "node:module";',
        `register(${JSON.stringify(loader.href)});`,
        `await import(${JSON.stringify(worker.href)});`,
      ].join("\n"),
    ]);
    const marker = "VIDCOM_MUTATION_HISTORY_RESULT=";
    const line = stdout.split("\n").find((value) => value.startsWith(marker));
    expect(line, stdout).toBeDefined();
    const sample = JSON.parse(line!.slice(marker.length)) as {
      receipts: number;
      warmup: number;
      heapDeltaBytes: number;
      rssDeltaBytes: number;
      releasedRefs: number;
      retainedReceiptIds: number;
      undoEntries: number;
      redoEntries: number;
    };
    process.stdout.write(`P15_MUTATION_HISTORY_SAMPLE ${JSON.stringify(sample)}\n`);

    expect(sample).toMatchObject({
      receipts: 100_000,
      warmup: 10_000,
      releasedRefs: 100_000,
      retainedReceiptIds: 4_096,
      undoEntries: 50,
      redoEntries: 0,
    });
    expect(sample.heapDeltaBytes).toBeLessThan(32 * 1024 * 1024);
    expect(sample.rssDeltaBytes).toBeLessThan(64 * 1024 * 1024);
  });

  it("does not let a second browser or project steal an attached studio id", () => {
    const { history } = fixture();
    attach(history);
    history.attach("browser-other", "studio", projectId);
    history.attach("browser-studio", "studio", "project_other" as ProjectId);

    expect(history.isAttached("browser-studio", "studio", projectId)).toBe(true);
    expect(history.isAttached("browser-other", "studio", projectId)).toBe(false);
    expect(history.isAttached("browser-studio", "studio", "project_other" as ProjectId)).toBe(false);
  });
});
