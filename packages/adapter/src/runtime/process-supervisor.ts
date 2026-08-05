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
export const PROCESS_COMMAND_TIMEOUT_MS = 2_000;
export const PROCESS_VERIFY_TIMEOUT_MS = 5_000;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

interface ProcessRow { pid: number; ppid: number | null; pgid: number | null; startedAt: string }
interface CaptureState { pids: Map<number, string>; groups: Map<number, string>; exhaustive: boolean }

/** True only when a numeric PID still names the exact process instance captured earlier. */
export function processIdentityMatches(
  captured: { pid: number; startedAt: string },
  current: { pid: number; startedAt: string } | undefined,
): boolean {
  return current?.pid === captured.pid && current.startedAt === captured.startedAt;
}

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

    const state: CaptureState = { pids: new Map(), groups: new Map(), exhaustive: true };
    const exit = new Promise<{ kind: "exit"; code: number | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ kind: "exit", code }));
    });
    const abort = new Promise<{ kind: "terminate"; reason: "abort" }>((resolve) => {
      input.signal?.addEventListener("abort", () => resolve({ kind: "terminate", reason: "abort" }), { once: true });
    });
    await this.captureOnce(rootPid, state);
    let captureInFlight = false;
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
      const proof = await this.terminateAndVerify(rootPid, state, first.reason, async () => {
        if (process.platform === "win32") await killPid(rootPid, true);
        else child.kill("SIGKILL");
        await Promise.race([exit.catch(() => ({ kind: "exit" as const, code: null })), sleep(PROCESS_COMMAND_TIMEOUT_MS)]);
      });
      return terminationResult(proof);
    } finally {
      clearInterval(captureTimer);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async captureOnce(
    rootPid: number,
    state: CaptureState,
  ): Promise<{ rows: ProcessRow[]; exhaustive: boolean }> {
    const snapshot = await enumerateProcesses();
    state.exhaustive &&= snapshot.exhaustive;
    if (!snapshot.exhaustive) return snapshot;
    for (const row of descendantsOf(snapshot.rows, rootPid)) {
      state.pids.set(row.pid, row.startedAt);
      if (row.pgid !== null) {
        const leader = snapshot.rows.find((candidate) => candidate.pid === row.pgid);
        if (leader) state.groups.set(row.pgid, leader.startedAt);
      }
    }
    const root = snapshot.rows.find((row) => row.pid === rootPid);
    if (root) {
      state.pids.set(root.pid, root.startedAt);
      if (root.pgid !== null) {
        const leader = snapshot.rows.find((row) => row.pid === root.pgid);
        if (leader) state.groups.set(root.pgid, leader.startedAt);
      }
    }
    return snapshot;
  }

  private async terminateAndVerify(
    rootPid: number,
    state: CaptureState,
    reason: "abort" | "timeout",
    killRoot: () => Promise<void>,
  ): Promise<ProcessTerminationProof> {
    await killRoot();
    await this.killCaptured(state);

    if (!state.exhaustive) {
      return {
        reason,
        rootPid,
        capturedPids: [...state.pids.keys()],
        capturedGroups: [...state.groups.keys()],
        survivors: [],
        sweeps: 1,
        exhaustive: false,
      };
    }

    let survivors: number[] = [];
    let consecutiveEmpty = 0;
    let sweeps = 0;
    const deadline = Date.now() + PROCESS_VERIFY_TIMEOUT_MS;
    while (sweeps < PROCESS_VERIFY_MAX_SWEEPS) {
      sweeps += 1;
      const snapshot = await this.captureOnce(rootPid, state);
      if (!snapshot.exhaustive) {
        survivors = [];
        break;
      }
      const current = new Map(snapshot.rows.map((row) => [row.pid, row.startedAt]));
      survivors = [...state.pids].flatMap(([pid, startedAt]) => {
        const actual = current.get(pid);
        if (actual !== undefined && actual !== startedAt) state.exhaustive = false;
        return processIdentityMatches({ pid, startedAt }, actual === undefined ? undefined : { pid, startedAt: actual })
          ? [pid] : [];
      });
      await Promise.all(survivors.map((pid) => killPid(pid)));
      consecutiveEmpty = survivors.length === 0 ? consecutiveEmpty + 1 : 0;
      if (consecutiveEmpty >= 2) break;
      if (Date.now() >= deadline) {
        state.exhaustive = false;
        survivors = [];
        break;
      }
      await sleep(PROCESS_VERIFY_SWEEP_INTERVAL_MS);
    }
    return {
      reason,
      rootPid,
      capturedPids: [...state.pids.keys()],
      capturedGroups: [...state.groups.keys()],
      survivors,
      sweeps,
      exhaustive: state.exhaustive && consecutiveEmpty >= 2,
    };
  }

  private async killCaptured(state: CaptureState): Promise<void> {
    const snapshot = await enumerateProcesses();
    state.exhaustive &&= snapshot.exhaustive;
    const current = new Map(snapshot.rows.map((row) => [row.pid, row.startedAt]));
    const kills: Promise<void>[] = [];
    for (const [group, startedAt] of state.groups) {
      if (processIdentityMatches({ pid: group, startedAt }, current.has(group)
        ? { pid: group, startedAt: current.get(group)! } : undefined)) kills.push(killGroup(group));
      else if (current.has(group)) state.exhaustive = false;
    }
    for (const [pid, startedAt] of state.pids) {
      if (processIdentityMatches({ pid, startedAt }, current.has(pid)
        ? { pid, startedAt: current.get(pid)! } : undefined)) kills.push(killPid(pid));
      else if (current.has(pid)) state.exhaustive = false;
    }
    await Promise.all(kills);
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
      const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,pgid=,lstart="], {
        encoding: "utf8", timeout: PROCESS_COMMAND_TIMEOUT_MS,
      });
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
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Csv -NoTypeInformation",
    ], { encoding: "utf8", timeout: PROCESS_COMMAND_TIMEOUT_MS });
    return { rows: parseWindowsCim(stdout), exhaustive: true };
  } catch {
    return { rows: [], exhaustive: false };
  }
}

function parsePosixTable(stdout: string): ProcessRow[] {
  return stdout.trim().split(/\r?\n/).flatMap((line) => {
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line.trim());
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAt: match[4]! }]
      : [];
  });
}

function parseWindowsCim(stdout: string): ProcessRow[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^"?(\d+)"?,"?(\d+)"?,"([^"]+)"$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: null, startedAt: match[3]! }] : [];
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
    await execFileAsync("taskkill", ["/pid", String(pid), ...(tree ? ["/t"] : []), "/f"], {
      encoding: "utf8", timeout: PROCESS_COMMAND_TIMEOUT_MS,
    });
  } catch { /* taskkill reports non-zero when the pid already exited */ }
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
