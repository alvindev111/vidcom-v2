import { describe, expect, it } from "vitest";

import type { ContentHash, RelPath } from "@vidcom/contracts";
import {
  classifyCompositeStep,
  decideCompositeRecovery,
  ok,
  rollbackObservedCompositeSteps,
  type ResolvedPath,
  type StepIntent,
  type WorkspacePort,
} from "@vidcom/core";

const digest = (value: string): ContentHash => `sha256:${value.padEnd(64, "0")}` as ContentHash;

describe("classifyCompositeStep", () => {
  const previous = digest("previous");
  const next = digest("next");

  it.each([
    ["write", { ordinal: 0, kind: "write", path: "index.html" as RelPath, entity: null, fromHash: previous, toHash: next, previousContent: "old" }],
    ["entity", { ordinal: 0, kind: "entity", path: null, entity: "preview-settings", fromHash: previous, toHash: next, previousContent: "old" }],
  ] satisfies Array<[string, StepIntent]>)("classifies %s from observed hashes", (_label, step) => {
    expect(classifyCompositeStep(step, next)).toBe("landed");
    expect(classifyCompositeStep(step, previous)).toBe("not_applied");
    expect(classifyCompositeStep(step, digest("other"))).toBe("unknown");
    expect(classifyCompositeStep(step, null)).toBe("unknown");
  });

  it("treats a missing newly-created write as not applied", () => {
    const step: StepIntent = {
      ordinal: 0,
      kind: "write",
      path: "new.html" as RelPath,
      entity: null,
      fromHash: null,
      toHash: next,
      previousContent: null,
    };
    expect(classifyCompositeStep(step, null)).toBe("not_applied");
  });

  it("ignores a tampered persisted status and trusts the observed hash", () => {
    const tampered = {
      ordinal: 0,
      kind: "write" as const,
      path: "index.html" as RelPath,
      entity: null,
      fromHash: previous,
      toHash: next,
      previousContent: "old",
      status: "written",
    };
    expect(classifyCompositeStep(tampered, previous)).toBe("not_applied");
    expect(classifyCompositeStep(tampered, digest("other"))).toBe("unknown");
  });

  it("classifies delete by absence and its original hash", () => {
    const step: StepIntent = {
      ordinal: 0,
      kind: "delete",
      path: "old.html" as RelPath,
      entity: null,
      fromHash: previous,
      toHash: null,
      previousContent: "old",
    };
    expect(classifyCompositeStep(step, null)).toBe("landed");
    expect(classifyCompositeStep(step, previous)).toBe("not_applied");
    expect(classifyCompositeStep(step, digest("other"))).toBe("unknown");
  });

  it("classifies mkdir/rmdir from directory state and durable existedBefore", () => {
    const mkdir: StepIntent = {
      ordinal: 0,
      kind: "mkdir",
      path: "assets" as RelPath,
      entity: null,
      fromHash: null,
      toHash: null,
      previousContent: null,
      existedBefore: false,
    };
    expect(classifyCompositeStep(mkdir, null, "directory")).toBe("landed");
    expect(classifyCompositeStep(mkdir, null, "absent")).toBe("not_applied");
    expect(classifyCompositeStep(mkdir, null, "other")).toBe("unknown");
    expect(classifyCompositeStep({ ...mkdir, existedBefore: true }, null, "directory")).toBe("landed");
    expect(classifyCompositeStep({ ...mkdir, existedBefore: true }, null, "absent")).toBe("unknown");

    const rmdir: StepIntent = { ...mkdir, kind: "rmdir", existedBefore: true };
    expect(classifyCompositeStep(rmdir, null, "absent")).toBe("landed");
    expect(classifyCompositeStep(rmdir, null, "directory")).toBe("not_applied");
  });

  it.each([
    [[], "orphan"],
    [["unknown"], "orphan"],
    [["landed", "unknown"], "orphan"],
    [["landed", "landed"], "roll_forward"],
    [["not_applied", "not_applied"], "abort"],
    [["not_applied", "landed"], "rollback"],
  ] as const)("decides %j as %s", (classifications, expected) => {
    expect(decideCompositeRecovery(classifications)).toBe(expected);
  });

  it("rolls landed steps back in descending ordinal order and verifies every restore", async () => {
    const first = "/workspace/project/first.html" as ResolvedPath;
    const second = "/workspace/project/second.html" as ResolvedPath;
    const hashes = new Map<ResolvedPath, ContentHash | null>([[first, next], [second, next]]);
    const operations: string[] = [];
    const workspace: WorkspacePort = {
      async resolve() { return ok(first); },
      async resolveWorkspace() { throw new Error("unused"); },
      async listProjects() { return []; },
      async readProjectRef() { return null; },
      async readFile() { return null; },
      async readBytes() { return null; },
      async readHash(target) { operations.push(`verify:${target}`); return hashes.get(target) ?? null; },
      async writeAtomic(target, content) {
        operations.push(`write:${target}:${String(content)}`);
        hashes.set(target, previous);
      },
      async exists() { return false; },
      async deleteAtomic() {},
      async captureForMutation() { throw new Error("unused"); },
      async publishCaptured() { throw new Error("unused"); },
      async restoreCaptured() { throw new Error("unused"); },
      async discardCapture() {},
      async readTree() { return []; },
      async stat() { return null; },
      async readDirectory() { return []; },
    };
    const makeStep = (ordinal: number, path: RelPath): StepIntent => ({
      ordinal,
      kind: "write",
      path,
      entity: null,
      fromHash: previous,
      toHash: next,
      previousContent: `old-${ordinal}`,
    });

    await expect(rollbackObservedCompositeSteps(workspace, [
      { step: makeStep(0, "first.html" as RelPath), target: first, actualHash: next, classification: "landed" },
      { step: makeStep(1, "second.html" as RelPath), target: second, actualHash: next, classification: "landed" },
    ])).resolves.toBe(true);
    expect(operations).toEqual([
      `write:${second}:old-1`, `verify:${second}`,
      `write:${first}:old-0`, `verify:${first}`,
    ]);
  });

  it("refuses rollback completion when restored content does not match fromHash", async () => {
    const target = "/workspace/project/index.html" as ResolvedPath;
    const workspace: WorkspacePort = {
      async resolve() { return ok(target); },
      async resolveWorkspace() { throw new Error("unused"); },
      async listProjects() { return []; },
      async readProjectRef() { return null; },
      async readFile() { return null; },
      async readBytes() { return null; },
      async readHash() { return next; },
      async writeAtomic() {},
      async exists() { return true; },
      async deleteAtomic() {},
      async captureForMutation() { throw new Error("unused"); },
      async publishCaptured() { throw new Error("unused"); },
      async restoreCaptured() { throw new Error("unused"); },
      async discardCapture() {},
      async readTree() { return []; },
      async stat() { return null; },
      async readDirectory() { return []; },
    };
    const step: StepIntent = {
      ordinal: 0,
      kind: "write",
      path: "index.html" as RelPath,
      entity: null,
      fromHash: previous,
      toHash: next,
      previousContent: "old",
    };
    await expect(rollbackObservedCompositeSteps(workspace, [
      { step, target, actualHash: next, classification: "landed" },
    ])).resolves.toBe(false);
  });
});
