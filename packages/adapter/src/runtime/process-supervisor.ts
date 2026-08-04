import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { ErrorCode } from "@vidcom/contracts";
import {
  type ProcessRunInput,
  type ProcessSupervisorPort,
  type ProcessTerminationProof,
  type SupervisedProcessResult,
} from "@vidcom/core";

import { allowlistedEnvironment } from "./process-environment";

export const PROCESS_CAPTURE_INTERVAL_MS = 250;
export const PROCESS_VERIFY_SWEEP_INTERVAL_MS = 100;
export const PROCESS_VERIFY_MAX_SWEEPS = 20;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

interface ProcessRow { pid: number; ppid: number | null; pgid: number | null }
interface CaptureState { pids: Set<number>; groups: Set<number>; exhaustive: boolean }

/** Error raised when direct PID probes still find survivors after the sweep budget. */
export class ProcessTerminationUnverifiedError extends Error {
  readonly code = ErrorCode.ProcessTerminationUnverified;
  constructor(readonly proof: ProcessTerminationProof) {
    super(`process termination could not be verified; survivors: ${proof.survivors.join(", ")}`);
    this.name = "ProcessTerminationUnverifiedError";
  }
}

/** Node implementation of the capture, kill and direct-probe process protocol. */
export class NodeProcessSupervisor implements ProcessSupervisorPort {
  constructor(private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async run(input: ProcessRunInput): Promise<SupervisedProcessResult> {
    const [executable, ...args] = input.command;
    if (!executable) throw new TypeError("process command must name an executable");
    input.signal?.throwIfAborted();

    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: allowlistedEnvironment(process.env, input.environment),
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid === undefined) {
      return await new Promise<never>((_resolve, reject) => child.once("error", reject));
    }
    const rootPid = child.pid;
    let stdout = "";
    let stderr = "";
    captureStream(child.stdout, (chunk) => { stdout = truncate(stdout + chunk); });
    captureStream(child.stderr, (chunk) => { stderr = truncate(stderr + chunk); });

    const state: CaptureState = { pids: new Set(), groups: new Set([rootPid]), exhaustive: true };
    const exit = new Promise<{ kind: "exit"; code: number | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ kind: "exit", code }));
    });
    const abort = new Promise<{ kind: "terminate"; reason: "abort" }>((resolve) => {
      input.signal?.addEventListener("abort", () => resolve({ kind: "terminate", reason: "abort" }), { once: true });
    });
    let captureInFlight = true;
    void this.captureOnce(rootPid, state).finally(() => { captureInFlight = false; });
    const captureTimer = setInterval(() => {
      if (captureInFlight) return;
      captureInFlight = true;
      void this.captureOnce(rootPid, state).finally(() => { captureInFlight = false; });
    }, PROCESS_CAPTURE_INTERVAL_MS);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ kind: "terminate"; reason: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ kind: "terminate", reason: "timeout" }),
        input.timeoutMs ?? this.defaultTimeoutMs,
      );
    });

    try {
      const first = await Promise.race([exit, abort, timeout]);
      if (first.kind === "exit") {
        return { status: "exited", output: { exitCode: first.code, stdout, stderr, timedOut: false } };
      }
      const proof = await this.terminateAndVerify(rootPid, state, first.reason);
      return terminationResult(proof);
    } finally {
      clearInterval(captureTimer);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async captureOnce(rootPid: number, state: CaptureState): Promise<void> {
    const snapshot = await enumerateProcesses();
    state.exhaustive &&= snapshot.exhaustive;
    if (!snapshot.exhaustive) return;
    for (const row of descendantsOf(snapshot.rows, rootPid)) {
      state.pids.add(row.pid);
      if (row.pgid !== null) state.groups.add(row.pgid);
    }
  }

  private async terminateAndVerify(
    rootPid: number,
    state: CaptureState,
    reason: "abort" | "timeout",
  ): Promise<ProcessTerminationProof> {
    for (const group of state.groups) await killGroup(group);
    for (const pid of state.pids) await killPid(pid);
    await killPid(rootPid);

    let survivors: number[] = [];
    let consecutiveEmpty = 0;
    let sweeps = 0;
    while (sweeps < PROCESS_VERIFY_MAX_SWEEPS) {
      sweeps += 1;
      await this.captureOnce(rootPid, state);
      survivors = (await Promise.all([...state.pids, rootPid].map(async (pid) => ({ pid, alive: await isAlive(pid) }))))
        .filter(({ alive }) => alive)
        .map(({ pid }) => pid);
      for (const pid of survivors) await killPid(pid);
      consecutiveEmpty = survivors.length === 0 ? consecutiveEmpty + 1 : 0;
      if (consecutiveEmpty >= 2) break;
      await sleep(PROCESS_VERIFY_SWEEP_INTERVAL_MS);
    }
    return {
      reason,
      rootPid,
      capturedPids: [...state.pids],
      capturedGroups: [...state.groups],
      survivors,
      sweeps,
      exhaustive: state.exhaustive && consecutiveEmpty >= 2,
    };
  }
}

/** Applies the survivor/error and degraded-proof/warning contract to termination evidence. */
export function terminationResult(
  proof: ProcessTerminationProof,
): Extract<SupervisedProcessResult, { status: "terminated" }> {
  if (proof.survivors.length > 0) throw new ProcessTerminationUnverifiedError(proof);
  return {
    status: "terminated",
    proof,
    warnings: proof.exhaustive ? [] : ["termination_proof_not_exhaustive"],
  };
}

/** Computes the descendant closure from one process-table snapshot. */
export function descendantsOf(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    if (row.ppid === null) continue;
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const result: ProcessRow[] = [];
  const queue = [rootPid];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

async function enumerateProcesses(): Promise<{ rows: ProcessRow[]; exhaustive: boolean }> {
  if (process.platform !== "win32") {
    try {
      const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,pgid="], { encoding: "utf8" });
      return { rows: parsePosixTable(stdout), exhaustive: true };
    } catch {
      return { rows: [], exhaustive: false };
    }
  }
  const disabled = new Set((process.env.VIDCOM_DISABLE_ENUMERATORS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  if (disabled.has("powershell-cim")) return { rows: [], exhaustive: false };
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation",
    ], { encoding: "utf8" });
    return { rows: parseWindowsCim(stdout), exhaustive: true };
  } catch {
    return { rows: [], exhaustive: false };
  }
}

function parsePosixTable(stdout: string): ProcessRow[] {
  return stdout.trim().split(/\r?\n/).flatMap((line) => {
    const values = line.trim().split(/\s+/).map(Number);
    return values.length >= 3 && values.every(Number.isInteger)
      ? [{ pid: values[0]!, ppid: values[1]!, pgid: values[2]! }]
      : [];
  });
}

function parseWindowsCim(stdout: string): ProcessRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^"?(\d+)"?,"?(\d+)"?$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: null }] : [];
  });
}

async function killGroup(group: number): Promise<void> {
  if (process.platform === "win32") return killPid(group, true);
  try { process.kill(-group, "SIGKILL"); } catch { /* already exited */ }
}

async function killPid(pid: number, tree = false): Promise<void> {
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    return;
  }
  try {
    await execFileAsync("taskkill", ["/pid", String(pid), ...(tree ? ["/t"] : []), "/f"], { encoding: "utf8" });
  } catch { /* taskkill reports non-zero when the pid already exited */ }
}

async function isAlive(pid: number): Promise<boolean> {
  if (process.platform !== "win32") {
    try { process.kill(pid, 0); return true; } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  try {
    const { stdout } = await execFileAsync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], { encoding: "utf8" });
    return stdout.split(/\r?\n/).some((line) => {
      const columns = line.trim().match(/^"[^"]*","(\d+)"/);
      return columns !== null && Number(columns[1]) === pid;
    });
  } catch { return false; }
}

function captureStream(stream: NodeJS.ReadableStream | null, append: (chunk: string) => void): void {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => append(chunk));
}

function truncate(value: string): string {
  return value.length > MAX_CAPTURE_BYTES ? value.slice(0, MAX_CAPTURE_BYTES) : value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
