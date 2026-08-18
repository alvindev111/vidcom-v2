// @vitest-environment node

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AppDataAssetStager, applyFontStyle, type StagedAssetOperations } from "@vidcom/adapter";
import { createApplication, hashContent, startVidcomFoundation } from "@vidcom/cli";
import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  applyFont,
  executeDeleteEntry,
  getEntryExpectation,
  prepareDeleteEntry,
  renameEntry,
  type AbsolutePath,
} from "@vidcom/core";

import { createSequentialIdPort } from "../support/deterministic";
import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];
const projectId = "project_entry_integration" as ProjectId;
const origin = {
  kind: "ui", sessionId: "01K30Y8Z7K0000000000000002", label: "Rename entry",
  historyAction: "record", historyOperation: null,
} as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(label: string, largeAsset = false) {
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-entry-${label}-`));
  roots.push(root);
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const project = await writeSampleProject(workspaceRoot, { slug: label, id: projectId });
  const source = path.join(project.root, "assets", "source");
  await mkdir(source, { recursive: true });
  await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(
    path.join(source, `file-${index.toString().padStart(3, "0")}.bin`),
    Buffer.from(`entry-${index}`),
  )));
  if (largeAsset) {
    const target = path.join(source, "file-000.bin");
    const handle = await open(target, "w", 0o600);
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    try {
      for (let index = 0; index < 96; index += 1) await handle.write(chunk);
      await handle.sync();
    } finally { await handle.close(); }
  }
  const foundation = await startVidcomFoundation({
    appDataRoot: path.join(root, "app-data"),
    workspaceRoot: workspaceRoot as AbsolutePath,
    holderId: `test:${label}`,
    clock: { now: () => new Date("2026-08-18T12:00:00.000Z") },
    ids: createSequentialIdPort(),
  }, {
    async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
  });
  return { root, project, source, foundation };
}

async function expectation(value: Awaited<ReturnType<typeof fixture>>) {
  const result = await getEntryExpectation({
    workspace: value.foundation.infrastructure.workspace,
    hashContent,
  }, { projectId, path: "assets/source" as RelPath });
  if (!result.ok || result.value.kind !== "folder") throw new Error("source tree expectation was unavailable");
  return result.value.expectedTreeDigest;
}

async function latestRevision(value: Awaited<ReturnType<typeof fixture>>): Promise<number> {
  return (await value.foundation.infrastructure.journal.latestRevision(projectId)) ?? 0;
}

async function measureRss<Value>(action: () => Promise<Value>): Promise<{ value: Value; delta: number }> {
  globalThis.gc?.();
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  try { return { value: await action(), delta: peak - baseline }; }
  finally { clearInterval(sampler); }
}

describe("entry CRUD real filesystem integration", () => {
  it("renames 200 files including a 96 MiB asset in one bounded-memory revision", { timeout: 120_000 }, async () => {
    const value = await fixture("rename-200", true);
    try {
      const treeDigest = await expectation(value);
      const beforeRevision = await latestRevision(value);
      const measured = await measureRss(() => renameEntry({
        ...value.foundation.application.writeDependencies,
        hashContent,
      }, {
        projectId,
        from: "assets/source" as RelPath,
        to: "assets/target" as RelPath,
        expectedRevision: beforeRevision,
        expected: { kind: "folder", treeDigest },
      }, "user", { origin, toolAudit: null }));
      const result = measured.value;

      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true, value: { envelope: { projectRevision: beforeRevision + 1 } },
      });
      expect(await latestRevision(value)).toBe(beforeRevision + 1);
      expect(await readdir(path.join(value.project.root, "assets", "target"))).toHaveLength(200);
      await expect(stat(value.source)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await stat(path.join(value.project.root, "assets", "target", "file-000.bin"))).size)
        .toBe(96 * 1024 * 1024);
      expect(measured.delta).toBeLessThan(64 * 1024 * 1024);
    } finally { await value.foundation.stop(); }
  });

  it("rolls back every target when staged publish 100 fails and leaves the revision unchanged", { timeout: 120_000 }, async () => {
    const value = await fixture("rollback-200", true);
    try {
      let publishes = 0;
      const operations: StagedAssetOperations = {
        async copySource(source, destination) {
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          let position = 0;
          while (true) {
            const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
            if (bytesRead === 0) return;
            await destination.write(buffer, 0, bytesRead, position);
            position += bytesRead;
          }
        },
        async link(from, to) {
          publishes += 1;
          if (publishes === 100) throw Object.assign(new Error("injected real publish failure"), { code: "EIO" });
          await link(from, to);
        },
        copyFile,
      };
      value.foundation.infrastructure.stagedAssets = new AppDataAssetStager(
        path.join(value.root, "app-data"),
        operations,
      );
      const failingApplication = createApplication(
        value.foundation.infrastructure,
        value.foundation.application.leaseId,
      );
      const treeDigest = await expectation(value);
      const beforeRevision = await latestRevision(value);
      const measured = await measureRss(() => renameEntry({ ...failingApplication.writeDependencies, hashContent }, {
        projectId,
        from: "assets/source" as RelPath,
        to: "assets/target" as RelPath,
        expectedRevision: beforeRevision,
        expected: { kind: "folder", treeDigest },
      }, "user", { origin, toolAudit: null }));
      const result = measured.value;

      expect(result, JSON.stringify(result)).toMatchObject({
        ok: false, error: { code: ErrorCode.StorageUnavailable },
      });
      expect(publishes).toBe(100);
      expect(await latestRevision(value)).toBe(beforeRevision);
      expect(await readdir(value.source)).toHaveLength(200);
      expect((await stat(path.join(value.source, "file-000.bin"))).size).toBe(96 * 1024 * 1024);
      await expect(stat(path.join(value.project.root, "assets", "target"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(measured.delta).toBeLessThan(64 * 1024 * 1024);
      expect(value.foundation.infrastructure.database.$client
        .prepare("SELECT COUNT(*) AS count FROM mutation_journal WHERE status IN ('pending', 'orphaned')").get())
        .toEqual({ count: 0 });
      expect(value.foundation.infrastructure.database.$client
        .prepare("SELECT COUNT(*) AS count FROM mutation_journal WHERE status = 'aborted'").get())
        .toEqual({ count: 1 });
    } finally { await value.foundation.stop(); }
  });

  it("deletes a 200-file tree with a 96 MiB asset through one granted bounded-memory revision", { timeout: 120_000 }, async () => {
    const value = await fixture("delete-200", true);
    try {
      const beforeRevision = await latestRevision(value);
      const prepared = await prepareDeleteEntry({
        ...value.foundation.application.writeDependencies,
        hashContent,
      }, {
        projectId,
        path: "assets/source" as RelPath,
        recursive: true,
        expectedRevision: beforeRevision,
      });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const requestId = await value.foundation.infrastructure.approvalRequests.request(
        prepared.value.binding,
        "Delete source tree",
      );
      const issued = await value.foundation.infrastructure.approvalRequests.issue(requestId, "ui");
      if (!issued.ok) throw new Error(issued.error.message);
      const measured = await measureRss(() => executeDeleteEntry({
        ...value.foundation.application.writeDependencies,
        hashContent,
      }, {
        projectId,
        path: "assets/source" as RelPath,
        recursive: true,
        expectedRevision: beforeRevision,
        grantId: issued.value,
      }, "user", { origin: { ...origin, label: "Delete entry" }, toolAudit: null }));
      const result = measured.value;

      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true, value: { envelope: { projectRevision: beforeRevision + 1 } },
      });
      await expect(stat(value.source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await latestRevision(value)).toBe(beforeRevision + 1);
      expect(measured.delta).toBeLessThan(64 * 1024 * 1024);
    } finally { await value.foundation.stop(); }
  });
});

function systemFont(): string | null {
  const candidates = process.platform === "darwin"
    ? ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Verdana.ttf"]
    : process.platform === "win32"
      ? ["C:\\Windows\\Fonts\\arial.ttf"]
      : ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];
  return candidates.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
}

describe("font production integration", () => {
  it("probes a real local font and applies its server-owned metadata through Core", async () => {
    const font = systemFont();
    expect(font, "a platform font fixture is required").not.toBeNull();
    const value = await fixture("font-apply");
    try {
      const fontPath = "assets/fonts/verified.ttf" as RelPath;
      const target = path.join(value.project.root, fontPath);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(font!, target);
      const bytes = await readFile(target);
      const fontHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
      const entry = await value.foundation.infrastructure.workspace.resolve(
        await value.foundation.infrastructure.workspace.readProjectRef(projectId).then((ref) => ref!),
        "index.html" as RelPath,
        "read-source",
      );
      if (!entry.ok) throw new Error("entry path did not resolve");
      const source = await value.foundation.infrastructure.workspace.readFile(entry.value);
      if (!source) throw new Error("entry source was unavailable");
      const result = await applyFont({
        ...value.foundation.application.writeDependencies,
        probe: value.foundation.infrastructure.assetProbe,
        styles: { apply: applyFontStyle },
      }, {
        projectId,
        fontPath,
        fontContentHash: fontHash,
        scope: { kind: "project" },
        expectedContentHash: source.contentHash,
      }, "user", { origin: { ...origin, label: "Apply font" }, toolAudit: null });

      expect(result).toMatchObject({ ok: true, value: { path: "index.html", family: expect.any(String), style: expect.any(String) } });
      expect(await readFile(path.join(value.project.root, "index.html"), "utf8"))
        .toContain("data-vidcom-font-target=\"document\"");
    } finally { await value.foundation.stop(); }
  });
});
