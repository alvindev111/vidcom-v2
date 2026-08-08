import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

/** One exact operating-system process instance, including its start identity. */
export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

/** Result of one OS process-table probe; non-exhaustive results cannot prove death or PID reuse. */
export interface ProcessIdentityProbeResult {
  identity: ProcessIdentity | undefined;
  exhaustive: boolean;
}

/** True only when a numeric PID still names the exact process instance captured earlier. */
export function processIdentityMatches(
  captured: { pid: number; startedAt: string },
  current: { pid: number; startedAt: string } | undefined,
): boolean {
  return current?.pid === captured.pid && current.startedAt === captured.startedAt;
}

/**
 * Reads the exact OS start identity currently assigned to `pid`, if any.
 *
 * An absent identity proves death only with `exhaustive: true`; malformed or
 * unavailable probe output returns `exhaustive: false` and remains unknown.
 */
export async function probeProcessIdentity(pid: number): Promise<ProcessIdentityProbeResult> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("process pid must be a positive safe integer");
  if (process.platform === "linux") return probeLinuxProcessIdentity(pid);
  if (process.platform === "win32") return probeWindowsProcessIdentity(pid);
  return probePosixProcessIdentity(pid);
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

const LINUX_BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const POSIX_START_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3][0-9] [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/u;

async function probeLinuxProcessIdentity(pid: number): Promise<ProcessIdentityProbeResult> {
  let bootId: string;
  try {
    bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } catch {
    return { identity: undefined, exhaustive: false };
  }
  if (!LINUX_BOOT_ID_PATTERN.test(bootId)) return { identity: undefined, exhaustive: false };

  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return hasErrorCode(error, "ENOENT")
      ? { identity: undefined, exhaustive: true }
      : { identity: undefined, exhaustive: false };
  }
  const prefix = `${pid} (`;
  const close = stat.lastIndexOf(") ");
  if (!stat.startsWith(prefix) || close < prefix.length) return { identity: undefined, exhaustive: false };
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  const state = fields[0];
  const startTicks = fields[19];
  if (!state || !/^[A-Za-z]$/u.test(state) || !startTicks || !/^[0-9]+$/u.test(startTicks)) {
    return { identity: undefined, exhaustive: false };
  }
  return {
    identity: { pid, startedAt: `linux-proc:${bootId}:${startTicks}` },
    exhaustive: true,
  };
}

async function probePosixProcessIdentity(pid: number): Promise<ProcessIdentityProbeResult> {
  let stdout: string;
  try {
    const result = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "pid=,lstart="], {
      encoding: "utf8",
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
      },
    });
    if (result.stderr !== "") return { identity: undefined, exhaustive: false };
    stdout = result.stdout;
  } catch (error) {
    return posixProbeProvesAbsent(error)
      ? { identity: undefined, exhaustive: true }
      : { identity: undefined, exhaustive: false };
  }
  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.length !== 1) return { identity: undefined, exhaustive: false };
  const match = /^\s*([0-9]+)\s+(.+?)\s*$/u.exec(lines[0] ?? "");
  if (!match || Number(match[1]) !== pid || !POSIX_START_PATTERN.test(match[2] ?? "")) {
    return { identity: undefined, exhaustive: false };
  }
  return {
    identity: { pid, startedAt: `posix-ps-utc:${match[2]}` },
    exhaustive: true,
  };
}

async function probeWindowsProcessIdentity(pid: number): Promise<ProcessIdentityProbeResult> {
  const disabled = new Set((process.env.VIDCOM_DISABLE_ENUMERATORS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  if (disabled.has("powershell-cim")) return { identity: undefined, exhaustive: false };
  const windowsRoot = process.env.SystemRoot;
  if (
    !windowsRoot
    || !path.win32.isAbsolute(windowsRoot)
    || path.win32.normalize(windowsRoot) !== windowsRoot
    || path.win32.basename(windowsRoot).toLowerCase() !== "windows"
  ) return { identity: undefined, exhaustive: false };
  const powershell = path.win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let stdout: string;
  try {
    const command = "$ErrorActionPreference = 'Stop'; "
      + `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop; `
      + "if ($null -eq $p) { 'VIDCOM_ABSENT' } else { "
      + "$created = $p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', "
      + "[System.Globalization.CultureInfo]::InvariantCulture); "
      + "$json = [ordered]@{ ProcessId = [int]$p.ProcessId; CreationDate = $created } | ConvertTo-Json -Compress; "
      + "'VIDCOM_FOUND ' + $json }";
    const result = await execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-Command", command,
    ], {
      encoding: "utf8",
      timeout: PROCESS_COMMAND_TIMEOUT_MS,
      env: windowsProbeEnvironment(windowsRoot, powershell),
    });
    if (result.stderr !== "") return { identity: undefined, exhaustive: false };
    stdout = result.stdout.trim();
  } catch {
    return { identity: undefined, exhaustive: false };
  }
  if (stdout === "VIDCOM_ABSENT") return { identity: undefined, exhaustive: true };
  if (!stdout.startsWith("VIDCOM_FOUND ") || stdout.includes("\n") || stdout.includes("\r")) {
    return { identity: undefined, exhaustive: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice("VIDCOM_FOUND ".length)) as unknown;
  } catch {
    return { identity: undefined, exhaustive: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { identity: undefined, exhaustive: false };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2
    || keys[0] !== "CreationDate"
    || keys[1] !== "ProcessId"
    || record.ProcessId !== pid
    || typeof record.CreationDate !== "string"
    || !canonicalWindowsCreationDate(record.CreationDate)
  ) return { identity: undefined, exhaustive: false };
  return {
    identity: { pid, startedAt: `windows-cim:${record.CreationDate}` },
    exhaustive: true,
  };
}

function windowsProbeEnvironment(windowsRoot: string, powershell: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    PATH: `${path.win32.dirname(powershell)};${path.win32.join(windowsRoot, "System32")}`,
    PSModulePath: path.win32.join(
      windowsRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    ),
  };
}

function canonicalWindowsCreationDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{7}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = `${value.slice(0, 23)}Z`;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === milliseconds;
}

function posixProbeProvesAbsent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return failure.code === 1
    && failure.stdout === ""
    && failure.stderr === "";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code;
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
