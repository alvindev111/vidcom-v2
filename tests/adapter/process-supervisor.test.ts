import { execFile, spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  NodeProcessSupervisor,
  PROCESS_CAPTURE_INTERVAL_MS,
  PROCESS_VERIFY_MAX_SWEEPS,
  PROCESS_VERIFY_TIMEOUT_MS,
  PROCESS_VERIFY_SWEEP_INTERVAL_MS,
  ProcessTerminationUnverifiedError,
  processIdentityMatches,
  terminationResult,
} from "@vidcom/adapter";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const fixture = path.resolve("spikes/phase-3-checklist-gate/process-tree-fixture.mjs");
const execFileAsync = promisify(execFile);
const hyperframesCli = path.resolve("node_modules/hyperframes/bin/hyperframes.mjs");
const realEngineAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync(process.execPath, [hyperframesCli, "browser", "path"], { stdio: "ignore" }).status === 0;

async function ledger(pathname: string): Promise<Array<{ pid: number; role: string }>> {
  const value = await readFile(pathname, "utf8").catch(() => "");
  return value.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForTree(pathname: string): Promise<Array<{ pid: number; role: string }>> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const rows = await ledger(pathname);
    if (rows.length >= 4) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return ledger(pathname);
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function forceCleanup(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone or Windows */ }
  }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("NodeProcessSupervisor", () => {
  it("pins the cross-platform capture and verification cadence", () => {
    expect(PROCESS_CAPTURE_INTERVAL_MS).toBe(250);
    expect(PROCESS_VERIFY_SWEEP_INTERVAL_MS).toBe(100);
    expect(PROCESS_VERIFY_MAX_SWEEPS).toBe(20);
    expect(PROCESS_VERIFY_TIMEOUT_MS).toBe(5_000);
  });

  it("does not treat a reused numeric PID as the captured process", () => {
    expect(processIdentityMatches(
      { pid: 42, startedAt: "2026-08-05T00:00:00Z" },
      { pid: 42, startedAt: "2026-08-05T00:00:01Z" },
    )).toBe(false);
  });

  it("rejects an exhausted direct-PID sweep instead of allowing cancelled", () => {
    const proof = {
      reason: "abort" as const,
      rootPid: 41,
      capturedPids: [42],
      capturedGroups: [41],
      survivors: [42],
      sweeps: PROCESS_VERIFY_MAX_SWEEPS,
      exhaustive: false,
    };
    expect(() => terminationResult(proof)).toThrowError(ProcessTerminationUnverifiedError);
    try { terminationResult(proof); } catch (error) {
      expect(error).toMatchObject({ code: "process_termination_unverified", proof });
    }
  });

  it("keeps an empty but non-exhaustive proof honest through a stable warning", () => {
    const result = terminationResult({
      reason: "abort",
      rootPid: 41,
      capturedPids: [],
      capturedGroups: [41],
      survivors: [],
      sweeps: 2,
      exhaustive: false,
    });
    expect(result.warnings).toEqual(["termination_proof_not_exhaustive"]);
    expect(result.proof.exhaustive).toBe(false);
  });

  it("captures a self-splitting real process tree and verifies direct PIDs after abort", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-supervisor-"));
    roots.push(root);
    const ledgerPath = path.join(root, "tree.ledger");
    await writeFile(ledgerPath, "", "utf8");
    const controller = new AbortController();
    const execution = new NodeProcessSupervisor(20_000).run({
      command: [process.execPath, fixture, "root", ledgerPath],
      signal: controller.signal,
    });
    const rows = await waitForTree(ledgerPath);
    try {
      expect(rows.map(({ role }) => role).sort()).toEqual(["escaping", "inGroup", "leaf", "root"]);
      await new Promise((resolve) => setTimeout(resolve, PROCESS_CAPTURE_INTERVAL_MS * 2));
      controller.abort();
      const result = await execution;
      expect(result.status).toBe("terminated");
      if (result.status !== "terminated") return;
      expect(result.proof.reason).toBe("abort");
      expect(result.proof.survivors).toEqual([]);
      if (process.platform === "win32" && !result.proof.exhaustive) {
        expect(result.warnings).toEqual(["termination_proof_not_exhaustive"]);
      } else {
        expect(result.proof.exhaustive).toBe(true);
        expect(result.warnings).toEqual([]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(rows.filter(({ pid }) => isAlive(pid))).toEqual([]);
      }
    } finally {
      controller.abort();
      await forceCleanup(rows.map(({ pid }) => pid));
    }
  }, 30_000);

  it("keeps cancellation proof exhaustive when the packaged PATH is empty", async () => {
    const previousPath = process.env.PATH;
    const controller = new AbortController();
    try {
      process.env.PATH = "";
      const execution = new NodeProcessSupervisor(20_000).run({
        command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, PROCESS_CAPTURE_INTERVAL_MS * 2));
      controller.abort();
      const result = await execution;
      expect(result.status).toBe("terminated");
      if (result.status !== "terminated") return;
      expect(result.proof).toMatchObject({ exhaustive: true, survivors: [] });
      expect(result.warnings).toEqual([]);
    } finally {
      controller.abort();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 30_000);

  it("proves a post-kill ppid walk can be empty while direct PID probes still find survivors", async () => {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(process.execPath, [
        path.resolve("spikes/phase-3-checklist-gate/s1e-cross-platform-supervision.mjs"),
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 }));
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (process.platform === "win32" && stderr.includes("Access denied")) return;
      throw error;
    }
    const result = JSON.parse(stdout) as {
      verdict: string;
      checks: { fixtureIntact: boolean; gateHolds: boolean; proofAgreesWithGroundTruth: boolean };
      platformProperty: { naiveGroupKillLeaks: boolean; ppidWalkReportsCleanWhileLeaking: boolean };
    };
    expect(result.checks).toMatchObject({ fixtureIntact: true, gateHolds: true, proofAgreesWithGroundTruth: true });
    expect(result.verdict).toMatch(/^PASS/);
    if (result.platformProperty.naiveGroupKillLeaks) {
      expect(result.platformProperty.ppidWalkReportsCleanWhileLeaking).toBe(true);
    }
  }, 35_000);

  it.skipIf(!realEngineAvailable)(
    "supervises a real Chromium/FFmpeg render (SKIP: Chromium or FFmpeg unavailable)",
    async () => {
      const { stdout } = await execFileAsync(process.execPath, [
        path.resolve("spikes/phase-3-checklist-gate/s1f-real-render-windows.mjs"),
      ], { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 });
      const result = JSON.parse(stdout) as {
        verdict: string;
        proof?: { survivors: number[]; exhaustive: boolean };
        survivorsByGroundTruthProbe?: unknown[];
      };
      expect(result.verdict).not.toBe("LEAKED_AND_PROOF_LIED");
      if (result.verdict === "TERMINATED_CLEAN") {
        expect(result.proof?.survivors).toEqual([]);
        expect(result.survivorsByGroundTruthProbe).toEqual([]);
      }
    },
    125_000,
  );
});
