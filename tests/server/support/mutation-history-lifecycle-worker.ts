import type { MutationOrigin, MutationReceipt, UndoContentPort, UndoContentRef } from "@vidcom/core";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { MutationHistory } from "@vidcom/server";

const projectId = "project_lifecycle_soak" as ProjectId;
const total = 100_000;
const warmup = 10_000;

function objectRef(id: number): UndoContentRef {
  return { kind: "object", contentHash: `sha256:soak-${id}` as ContentHash, encoding: "binary" };
}

function receipt(id: number, ref: UndoContentRef): MutationReceipt {
  const path = `scenes/soak-${id}.html` as RelPath;
  const origin: MutationOrigin = {
    kind: "ui",
    sessionId: "studio",
    label: "soak edit",
    historyAction: "record",
    historyOperation: null,
  };
  return {
    id: `soak-${id}`,
    projectId,
    origin,
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
    projectRevision: id + 1,
    at: "2026-08-18T00:00:00.000Z",
    undoable: true,
  };
}

async function collect(): Promise<NodeJS.MemoryUsage> {
  globalThis.gc?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.gc?.();
  return process.memoryUsage();
}

async function main(): Promise<void> {
  if (globalThis.gc === undefined) throw new Error("mutation-history soak requires --expose-gc");
  let releasedRefs = 0;
  const content: UndoContentPort = {
    async retainBytes() { throw new Error("not used"); },
    async retainFile() { throw new Error("not used"); },
    async resolve() { throw new Error("not used"); },
    release(refs) { releasedRefs += refs.length; },
  };
  const history = new MutationHistory(content);
  history.attach("browser-studio", "studio", projectId);

  for (let index = 0; index < warmup; index += 1) {
    history.emit(receipt(index, objectRef(index)));
  }
  const baseline = await collect();
  for (let index = warmup; index < total; index += 1) {
    history.emit(receipt(index, objectRef(index)));
  }
  const retained = await collect();
  const diagnostics = history.diagnosticState();
  history.clear("studio", projectId);

  process.stdout.write(`VIDCOM_MUTATION_HISTORY_RESULT=${JSON.stringify({
    receipts: total,
    warmup,
    heapDeltaBytes: Math.max(0, retained.heapUsed - baseline.heapUsed),
    rssDeltaBytes: Math.max(0, retained.rss - baseline.rss),
    baseline,
    retained,
    releasedRefs,
    ...diagnostics,
  })}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
