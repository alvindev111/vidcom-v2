import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyFontStyle } from "@vidcom/adapter";
import { hashContent, startVidcomFoundation } from "@vidcom/cli";
import type { AbsolutePath } from "@vidcom/core";
import { bindLoopback, createServerApp, InMemoryNonceStore, InMemorySessionStore } from "@vidcom/server";

import { createSequentialIdPort } from "../../support/deterministic";
import { writeSampleProject } from "../../support/sample-project";

const FIVE_HUNDRED_MB = 500 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const OPERATION_ID = "01K30Y8Z7K0000000000000001";

interface UploadInput {
  origin: string; cookie: string; projectId: string; filename: string;
  kind?: "image" | "video" | "audio"; bytes: number; expectedRevision: number;
  contentLength: boolean; operationId?: string; atSeconds?: number; trackIndex?: number;
  abortAfter?: number; validMagic?: boolean;
}

function uploadGenerated(input: UploadInput): Promise<{ status: number; body: string }> {
  const source = String.raw`
    const { request } = require("node:http");
    const input = JSON.parse(process.argv[1]);
    let responseStarted = false;
    const query = new URLSearchParams({ kind: input.kind || "video", filename: input.filename,
      expectedRevision: String(input.expectedRevision) });
    if (input.operationId) { query.set("operationId", input.operationId); query.set("atSeconds", String(input.atSeconds));
      query.set("trackIndex", String(input.trackIndex)); }
    const target = new URL("/api/v1/projects/" + input.projectId + "/assets?" + query, input.origin);
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search,
      method: "POST", headers: { Cookie: input.cookie, "Content-Type": "application/octet-stream",
        ...(input.contentLength ? { "Content-Length": String(input.bytes) } : {}) } }, (res) => {
      responseStarted = true;
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => process.stdout.write(JSON.stringify({ status: res.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8") })));
    });
    req.on("error", (error) => responseStarted ? undefined : input.abortAfter === undefined
      ? (process.stderr.write(String(error)), process.exit(2))
      : process.stdout.write(JSON.stringify({ status: 0, body: String(error) })));
    (async () => {
      const chunk = Buffer.alloc(${CHUNK_BYTES});
      if (input.validMagic !== false) {
        if (input.kind === "image") Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(chunk);
        else if (input.kind === "audio") Buffer.from("ID3").copy(chunk);
        else Buffer.from("ftyp").copy(chunk, 4);
      }
      let sent = 0;
      while (sent < input.bytes) {
        if (responseStarted) return;
        const size = Math.min(chunk.length, input.bytes - sent); sent += size;
        if (!req.write(size === chunk.length ? chunk : chunk.subarray(0, size)))
          await new Promise((done) => req.once("drain", done));
        if (input.abortAfter !== undefined && sent >= input.abortAfter) {
          req.destroy(new Error("intentional upload abort")); return;
        }
      }
      req.end();
    })().catch((error) => { process.stderr.write(String(error)); process.exit(3); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8") || `upload client exited ${code}`));
      try { resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as { status: number; body: string }); }
      catch { reject(new Error("upload client returned invalid output")); }
    });
  });
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-asset-listener-worker-"));
  const workspaceRoot = path.join(root, "workspace");
  await mkdir(workspaceRoot);
  const projectId = "project_asset_listener";
  const project = await writeSampleProject(workspaceRoot, { slug: "asset-listener", id: projectId });
  const clock = { now: () => new Date("2026-08-18T00:00:00.000Z") };
  const foundation = await startVidcomFoundation({
    appDataRoot: path.join(root, "app-data"), workspaceRoot: workspaceRoot as AbsolutePath,
    holderId: "test:asset-listener", clock, ids: createSequentialIdPort(),
  }, {
    async recoverJobs() {}, async startScheduler() {}, async startWatcher() {}, async openListener() { return null; },
  });
  const nonces = new InMemoryNonceStore(clock);
  const sessions = new InMemorySessionStore(clock);
  const listener = await bindLoopback((port) => createServerApp({
    port, uiOrigins: [], nonces, sessions,
    projectReads: {
      ...foundation.application.readDependencies,
      runtimeSource: foundation.infrastructure.runtimeSource,
      mimeFromPath: foundation.infrastructure.mimeFromPath,
      probe: foundation.infrastructure.assetProbe,
      hashContent,
    },
    projectWrites: {
      ...foundation.application.writeDependencies,
      reads: foundation.application.readDependencies,
      bgmSynth: foundation.infrastructure.bgmSynth,
      bgmLibrary: foundation.infrastructure.bgmLibrary,
      approvals: foundation.infrastructure.approvalRequests,
      hashContent,
      mimeFromPath: foundation.infrastructure.mimeFromPath,
      staging: foundation.infrastructure.assetStaging,
      sanitizer: foundation.infrastructure.assetSanitizer,
      pendingMount: foundation.infrastructure.pendingMount,
      probe: foundation.infrastructure.assetProbe,
      styles: { apply: applyFontStyle },
    },
  }));
  try {
    const origin = `http://127.0.0.1:${listener.port}`;
    const exchange = await fetch(`${origin}/api/v1/auth/exchange`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: nonces.issue() }),
    });
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const common = { origin, cookie, projectId };
    const warmup = await uploadGenerated({
      ...common, filename: "warmup.mp4", bytes: 64 * 1024 * 1024, expectedRevision: 0, contentLength: true,
    });
    globalThis.gc?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const baselineMemory = process.memoryUsage();
    const baselineRss = baselineMemory.rss;
    let peakRss = baselineRss;
    let peakMemory = process.memoryUsage();
    const sample = setInterval(() => {
      const memory = process.memoryUsage();
      if (memory.rss > peakRss) { peakRss = memory.rss; peakMemory = memory; }
    }, 2);
    const exact = await uploadGenerated({
      ...common, filename: "exact.mp4", bytes: FIVE_HUNDRED_MB, expectedRevision: 1, contentLength: true,
    });
    clearInterval(sample);
    const oneOver = await uploadGenerated({
      ...common, filename: "one-over.mp4", bytes: FIVE_HUNDRED_MB + 1, expectedRevision: 2, contentLength: false,
    });
    const oversized = await uploadGenerated({
      ...common, filename: "oversized.mp4", bytes: 512 * 1024 * 1024, expectedRevision: 2, contentLength: true,
    });
    await uploadGenerated({
      ...common, filename: "cancelled.mp4", bytes: FIVE_HUNDRED_MB, expectedRevision: 2,
      contentLength: false, abortAfter: 4 * CHUNK_BYTES,
    });
    const tempDirectory = path.join(project.root, ".vidcom", "tmp");
    let tempAfterAbort: string[] = [];
    const cleanupDeadline = Date.now() + 2_000;
    do {
      tempAfterAbort = (await readdir(tempDirectory)).filter((name) => name.startsWith("asset-"));
      if (tempAfterAbort.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < cleanupDeadline);

    const replayInput = {
      ...common, filename: "replay.mp4", bytes: 2 * CHUNK_BYTES, expectedRevision: 2,
      contentLength: false, operationId: OPERATION_ID, atSeconds: 1.25, trackIndex: 0,
    } as const;
    const first = await uploadGenerated(replayInput);
    const firstBody = JSON.parse(first.body) as { path: string; projectRevision: number; replayed: boolean };
    const target = path.join(project.root, firstBody.path);
    const firstStat = await stat(target, { bigint: true });
    const journalCountBeforeReplay = foundation.infrastructure.database.$client
      .prepare("SELECT COUNT(*) AS count FROM mutation_journal").get() as { count: number };
    const replay = await uploadGenerated(replayInput);
    const replayBody = JSON.parse(replay.body) as { projectRevision: number; replayed: boolean };
    const replayStat = await stat(target, { bigint: true });
    const journalCountAfterReplay = foundation.infrastructure.database.$client
      .prepare("SELECT COUNT(*) AS count FROM mutation_journal").get() as { count: number };
    const changedInputs: UploadInput[] = [
      { ...replayInput, filename: "changed-name.mp4" },
      { ...replayInput, kind: "audio", filename: "replay.mp3" },
      { ...replayInput, atSeconds: 1.5 },
      { ...replayInput, trackIndex: 1 },
      { ...replayInput, bytes: 3 * CHUNK_BYTES },
    ];
    const changed = await Promise.all(changedInputs.map((input) => uploadGenerated(input)));
    foundation.infrastructure.database.$client
      .prepare("DELETE FROM pending_mount WHERE operation_id = ? AND project_id = ?").run(OPERATION_ID, projectId);
    const expired = await uploadGenerated(replayInput);
    process.stdout.write(`\nVIDCOM_ASSET_STREAM_RESULT=${JSON.stringify({
      warmupStatus: warmup.status, exactStatus: exact.status, rssDeltaBytes: peakRss - baselineRss,
      baselineRss, baselineMemory, peakRss, peakMemory, oneOverStatus: oneOver.status, oversizedStatus: oversized.status,
      tempAfterAbort, firstStatus: first.status, replayStatus: replay.status, replayed: replayBody.replayed,
      replayRevisionStable: replayBody.projectRevision === firstBody.projectRevision,
      replayWriteStable: replayStat.mtimeNs === firstStat.mtimeNs && replayStat.size === firstStat.size,
      replayJournalStable: journalCountAfterReplay.count === journalCountBeforeReplay.count,
      changedStatuses: changed.map(({ status }) => status), expiredStatus: expired.status,
    })}\n`);
  } finally {
    await listener.close();
    await foundation.stop();
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
