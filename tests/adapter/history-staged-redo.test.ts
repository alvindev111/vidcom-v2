// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LargePreviousContentStore } from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import {
  applyMutationInverse,
  ok,
  type AbsolutePath,
  type CompositeRequest,
  type MutationReceipt,
  type ProjectRef,
} from "@vidcom/core";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const projectId = "project_history_staged" as ProjectId;

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("large staged history redo", () => {
  it("resolves retained object bytes after the original staged cache file is evicted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-history-staged-"));
    roots.push(root);
    const sourcePath = path.join(root, "catalog-cache.bin") as AbsolutePath;
    const bytes = new Uint8Array(2 * 1024 * 1024).fill(0x5a);
    await writeFile(sourcePath, bytes);
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
    const store = new LargePreviousContentStore(root);
    const retained = await store.retainFile({ sourcePath, contentHash }, "binary");
    await unlink(sourcePath);

    const ref: ProjectRef = {
      id: projectId,
      slug: "history-staged",
      root: "/workspace/history-staged" as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const receipt: MutationReceipt = {
      id: "journal:staged",
      projectId,
      origin: { kind: "ui", sessionId: "studio", label: "Install package", historyAction: "record", historyOperation: null },
      steps: [{
        kind: "file",
        undoable: true,
        path: "assets/package.bin" as RelPath,
        beforeContent: null,
        afterContent: retained,
        fromHash: null,
        toHash: contentHash,
      }],
      paths: ["assets/package.bin" as RelPath],
      readGuards: [],
      projectRevision: 1,
      at: "2026-08-18T00:00:00.000Z",
      undoable: true,
    };
    const requests: CompositeRequest[] = [];
    const inverse = { ...receipt, id: "journal:inverse" };
    const result = await applyMutationInverse({
      workspace: { async readProjectRef() { return ref; } },
      composition: {},
      journal: { async readEntityState() { return null; } },
      authority: {
        async mutateSource(request: CompositeRequest) {
          requests.push(request);
          return ok({
            projectRevision: 2,
            entityRevision: null,
            fileHashes: { ["assets/package.bin" as RelPath]: contentHash },
            diagnostics: [],
            changeSeq: 2,
            inverseReceipt: inverse,
          });
        },
      },
      clock: { now: () => new Date("2026-08-18T00:00:00.000Z") },
      undoContent: store,
    } as never, {
      projectId,
      receipt,
      direction: "redo",
    }, "user", {
      kind: "ui",
      sessionId: "studio",
      label: "Redo install package",
      historyAction: "redo",
      historyOperation: { id: "operation-staged", targetReceiptId: receipt.id },
    });

    expect(result.ok).toBe(true);
    expect(requests[0]?.steps).toEqual([{
      kind: "write-staged",
      path: "assets/package.bin",
      source: { sourcePath: expect.not.stringContaining("catalog-cache.bin"), contentHash },
      expectedContentHash: null,
      undoable: true,
    }]);
    store.release([retained]);
  });
});
