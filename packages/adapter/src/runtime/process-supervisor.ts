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
/**
 * Headroom for the identity probe, which spawns PowerShell and is answered in
 * roughly 350ms once its environment is right.
 *
 * The budget is not what made this probe fail — a bad `PSModulePath` did — but
 * it stays separate from the 2s termination budget: an inconclusive self-probe
 * stops a directory lock from ever being published, so this one is worth
 * waiting on rather than abandoning early.
 */
export const PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 15_000;

/**
 * Scheme prefix on every Windows start identity.
 *
 * Identities are compared as opaque strings, so changing how one is measured
 * would make an identity written by another build look like a different
 * process — and a live lock owner would be reclaimed as if it had died. The
 * prefix names the measurement, and a prefix this build did not produce is
 * treated as unknown rather than dead. `windows-cim:` was the WMI-backed
 * predecessor; it must never be re-used for a different measurement.
 */
export const WINDOWS_IDENTITY_SCHEME = "windows-start";

/** The measurement that produced an identity, or undefined when unlabelled. */
export function identityScheme(startedAt: string): string | undefined {
  const separator = startedAt.indexOf(":");
  return separator <= 0 ? undefined : startedAt.slice(0, separator);
}

/**
 * True when two identities were measured the same way and can be compared.
 *
 * Identities from different schemes carry no information about each other: they
 * are neither a match nor a mismatch.
 */
export function identitySchemesAgree(left: string, right: string): boolean {
  return identityScheme(left) === identityScheme(right);
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

interface ProcessRow { pid: number; ppid: number | null; pgid: number | null; startedAt: string }
interface CaptureState { pids: Map<number, string>; groups: Map<number, string>; exhaustive: boolean }

export interface NodeProcessSupervisorOptions {
  /** Trusted values required by every child; per-invocation duplicates cannot replace them. */
  defaultEnvironment?: Readonly<Record<string, string>>;
  /** Configured trust bundle for every supervised Node child. */
  caBundlePath?: string;
}

/** One exact operating-system process instance, including its start identity. */
export interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

/** Result of one OS process-table probe; non-exhaustive results cannot prove death or PID reuse. */
export interface ProcessIdentityProbeResult {
  identity: ProcessIdentity | undefined;
  exhaustive: boolean;
  /**
   * Why an inconclusive probe gave up. Diagnostics only — never a control flow
   * input. A blind probe stops a directory lock from being published, and
   * without this the failure is indistinguishable from lock contention.
   */
  reason?: string;
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

let currentProcessIdentity: { pid: number; result: ProcessIdentityProbeResult } | undefined;

/**
 * Probes this process's own identity at most once.
 *
 * A live process cannot change its own PID or start time, so repeating the probe
 * only repeats its cost — on Windows a PowerShell spawn per call. Only an
 * exhaustive answer is cached; an inconclusive probe stays retryable.
 */
export async function probeCurrentProcessIdentity(): Promise<ProcessIdentityProbeResult> {
  if (currentProcessIdentity?.pid === process.pid) return currentProcessIdentity.result;
  const result = await probeProcessIdentity(process.pid);
  if (result.exhaustive && result.identity !== undefined) {
    currentProcessIdentity = { pid: process.pid, result };
  }
  return result;
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
  constructor(
    private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly options: NodeProcessSupervisorOptions = {},
  ) {}

  async run(input: ProcessRunInput): Promise<SupervisedProcessResult> {
    const [executable, ...args] = input.command;
    if (!executable) throw new TypeError("process command must name an executable");
    input.signal?.throwIfAborted();
    const configuredEnvironment = {
      ...this.options.defaultEnvironment,
      ...(this.options.caBundlePath
        ? { NODE_EXTRA_CA_CERTS: this.options.caBundlePath }
        : {}),
    };

    const child = spawn(executable, args, {
      cwd: input.cwd,
      env: allowlistedEnvironment(
        process.env,
        { ...input.environment, ...configuredEnvironment },
        { caBundlePath: this.options.caBundlePath },
      ),
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
  const blind = (reason: string): ProcessIdentityProbeResult =>
    ({ identity: undefined, exhaustive: false, reason });
  const disabled = new Set((process.env.VIDCOM_DISABLE_ENUMERATORS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean));
  if (disabled.has("powershell-cim")) return blind("powershell probe disabled by VIDCOM_DISABLE_ENUMERATORS");
  const windowsRoot = process.env.SystemRoot;
  if (
    !windowsRoot
    || !path.win32.isAbsolute(windowsRoot)
    || path.win32.normalize(windowsRoot) !== windowsRoot
    || path.win32.basename(windowsRoot).toLowerCase() !== "windows"
  ) return blind(`SystemRoot is not a canonical Windows directory: ${windowsRoot ?? "<unset>"}`);
  const powershell = path.win32.join(
    windowsRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let stdout: string;
  try {
    // `Get-Process` reads the process object directly through .NET. The former
    // `Get-CimInstance` query went through WMI, which hung past every budget on
    // CI runners and left this probe permanently inconclusive.
    const command = "$ErrorActionPreference = 'Stop'; "
      + `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
      + "if ($null -eq $p) { 'VIDCOM_ABSENT' } else { "
      + "$started = $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffffffZ', "
      + "[System.Globalization.CultureInfo]::InvariantCulture); "
      + "$json = [ordered]@{ ProcessId = [int]$p.Id; StartTime = $started } | ConvertTo-Json -Compress; "
      + "'VIDCOM_FOUND ' + $json }";
    const result = await execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-Command", command,
    ], {
      encoding: "utf8",
      timeout: PROCESS_IDENTITY_PROBE_TIMEOUT_MS,
      env: windowsProbeEnvironment(windowsRoot, powershell),
    });
    if (result.stderr !== "") return blind(`powershell wrote to stderr: ${truncateReason(result.stderr)}`);
    stdout = result.stdout.trim();
  } catch (error) {
    const forwarded = WINDOWS_PROBE_PASSTHROUGH.filter((name) => process.env[name] !== undefined);
    return blind(
      `powershell probe failed: ${probeFailureDetail(error)}`
      + ` (forwarded: ${forwarded.join(",") || "none"})`,
    );
  }
  if (stdout === "VIDCOM_ABSENT") return { identity: undefined, exhaustive: true };
  if (!stdout.startsWith("VIDCOM_FOUND ") || stdout.includes("\n") || stdout.includes("\r")) {
    return blind(`unexpected probe output: ${truncateReason(stdout)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice("VIDCOM_FOUND ".length)) as unknown;
  } catch {
    return blind("probe output was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return blind("probe output was not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2
    || keys[0] !== "ProcessId"
    || keys[1] !== "StartTime"
    || record.ProcessId !== pid
    || typeof record.StartTime !== "string"
    || !canonicalWindowsCreationDate(record.StartTime)
  ) return blind("probe output did not describe the requested process canonically");
  return {
    identity: { pid, startedAt: `${WINDOWS_IDENTITY_SCHEME}:${record.StartTime}` },
    exhaustive: true,
  };
}

function truncateReason(value: string): string {
  const single = value.replace(/\s+/gu, " ").trim();
  return single.length > 200 ? `${single.slice(0, 200)}…` : single;
}

/** Names the mechanical cause: a timeout, a kill signal, an exit code, or a spawn error. */
function probeFailureDetail(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const failure = error as { killed?: boolean; signal?: string; code?: unknown; message?: string };
  if (failure.killed === true || failure.signal) {
    return `timed out after ${PROCESS_IDENTITY_PROBE_TIMEOUT_MS}ms (signal ${failure.signal ?? "none"})`;
  }
  if (failure.code !== undefined) return `exit ${String(failure.code)}: ${truncateReason(failure.message ?? "")}`;
  return truncateReason(failure.message ?? String(error));
}

/**
 * Variables PowerShell itself needs to start, forwarded verbatim when present.
 *
 * The allowlist exists so the probe cannot be steered by an attacker-controlled
 * environment, but trimming it to five entries starved PowerShell of its
 * temp directory and drive layout and it hung until the probe timed out. These
 * names are read, never interpreted, by this process.
 */
const WINDOWS_PROBE_PASSTHROUGH = [
  "SystemDrive",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
] as const;

/**
 * Builds the environment the Windows identity probe runs under.
 *
 * `PSModulePath` is deliberately empty. Pointing it at the single stock module
 * directory made every process-inspecting cmdlet hang until it was killed —
 * measured on CI at over 20s for `Get-Process` and `Get-CimInstance` alike,
 * while the same shell answered `'ok'` in 244ms. Empty answers in ~320ms
 * because module discovery never runs, and the cmdlets this probe needs are
 * already in the default session. Empty is also the stricter setting: no
 * directory on the module path can introduce code into the probe. Deleting the
 * variable is NOT equivalent — PowerShell then computes its own default and
 * hangs again.
 */
export function windowsProbeEnvironment(windowsRoot: string, powershell: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    PATH: `${path.win32.dirname(powershell)};${path.win32.join(windowsRoot, "System32")}`,
    PSModulePath: "",
  };
  for (const name of WINDOWS_PROBE_PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
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
