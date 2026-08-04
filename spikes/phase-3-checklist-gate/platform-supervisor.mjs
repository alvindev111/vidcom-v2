// Platform primitives + the three-phase supervision algorithm from §5.9.
//
// Three primitives is the whole platform surface. Everything above them is
// shared, so a platform difference can only ever be in one of these three and
// the algorithm itself does not fork per OS:
//
//   enumerate() -> [{ pid, ppid, pgid }]   who is alive, and how they relate
//   killGroup(id) / killPid(pid)           terminate
//   isAlive(pid)                           liveness of ONE recorded pid
//
// `isAlive` is the load-bearing one. S1c proved a ppid walk reads empty while
// processes are alive (children reparent to pid 1 when the parent dies), and a
// group sweep cannot see a process that left the group. Only a direct probe of a
// pid recorded earlier answers the real question.
import { execFileSync, spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryRun(command, args) {
  try {
    const out = execFileSync(command, args, { encoding: "utf8", maxBuffer: 32 << 20, windowsHide: true });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: "", error: String(error.message ?? error).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- enumeration

function enumeratePosix() {
  const { ok, out } = tryRun("ps", ["-Ao", "pid=,ppid=,pgid="]);
  if (!ok) return [];
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3] });
  }
  return rows;
}

// Windows has no single obvious answer, which is the point of probing rather
// than assuming. `wmic` is gone from Windows Server 2025 and Windows 11 24H2 —
// and from the GitHub `windows-latest` image since September 2025 — while
// `tasklist` carries no parent pid at all. That leaves PowerShell CIM as the only
// parent-capable source on a modern Windows, which is why §5.9's blanket ban on
// PowerShell was narrowed to "not on the hot path" rather than "never".
//
// Set VIDCOM_DISABLE_ENUMERATORS=powershell-cim to force the degraded path;
// without it, the branch a locked-down Windows will hit would never be exercised
// anywhere.
const DISABLED = new Set((process.env.VIDCOM_DISABLE_ENUMERATORS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

// `wmic` is deliberately NOT here (D10). It would be faster where it still
// exists, but it exists on no CI platform any more — Server 2025 dropped it — so
// it would be a branch nothing ever runs, kept for old Windows and trusted
// without evidence. That is the exact shape of defect this spec has already been
// bitten by twice. One path, tested every run, at the cost of a few hundred
// milliseconds per cancel on older machines.
const WINDOWS_ENUMERATORS = [
  {
    name: "tasklist-csv",
    // Liveness and image name only — no ppid, so it cannot build a tree. Listed
    // because liveness is still the primitive `isAlive` needs.
    probe: () => tryRun("tasklist", ["/fo", "csv", "/nh"]),
    parse: (out) => out.split("\n").flatMap((line) => {
      const m = line.match(/^"([^"]*)","(\d+)"/);
      return m ? [{ pid: +m[2], ppid: null, pgid: null, name: m[1] }] : [];
    }),
    providesParent: false,
  },
  {
    name: "powershell-cim",
    // Eligible on the CANCEL path only (§5.9). Cancels are rare — a few per day —
    // so a few hundred milliseconds once per cancel is affordable in a way that
    // the same call per spawn would not be.
    probe: () => tryRun("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId)\" }"]),
    parse: (out) => out.split("\n").flatMap((line) => {
      const m = line.trim().match(/^(\d+),(\d+)$/);
      return m ? [{ pid: +m[1], ppid: +m[2], pgid: null }] : [];
    }),
    providesParent: true,
  },
];

export function probeWindowsEnumerators() {
  return WINDOWS_ENUMERATORS.map((candidate) => {
    if (DISABLED.has(candidate.name)) {
      return { name: candidate.name, available: false, providesParent: candidate.providesParent,
               rowCount: 0, ms: 0, error: "disabled via VIDCOM_DISABLE_ENUMERATORS" };
    }
    const started = process.hrtime.bigint();
    const result = candidate.probe();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const rows = result.ok ? candidate.parse(result.out) : [];
    return {
      name: candidate.name,
      available: result.ok && rows.length > 0,
      providesParent: candidate.providesParent,
      rowCount: rows.length,
      ms: +ms.toFixed(1),
      error: result.ok ? null : result.error,
    };
  });
}

/** Windows build string, so a green result is qualified by which OS produced it. */
export function osIdentity() {
  if (!isWindows) {
    const { out } = tryRun("uname", ["-sr"]);
    return { platform: process.platform, detail: out.trim() || "unknown" };
  }
  const { out } = tryRun("cmd", ["/c", "ver"]);
  return { platform: "win32", detail: out.trim().replace(/\s+/g, " ") || "unknown" };
}

let windowsEnumerator = null;
function selectWindowsEnumerator() {
  if (windowsEnumerator !== null) return windowsEnumerator;
  // Prefer a parent-capable source; fall back to liveness-only, which still
  // supports the verify phase even when the capture phase has to degrade.
  const probes = probeWindowsEnumerators();
  const chosen = probes.find((p) => p.available && p.providesParent) ?? probes.find((p) => p.available);
  windowsEnumerator = chosen
    ? { ...WINDOWS_ENUMERATORS.find((c) => c.name === chosen.name), report: chosen }
    : { name: "none", parse: () => [], probe: () => ({ ok: false, out: "" }), providesParent: false, report: null };
  return windowsEnumerator;
}

export function enumerate() {
  if (!isWindows) return enumeratePosix();
  const chosen = selectWindowsEnumerator();
  const result = chosen.probe();
  return result.ok ? chosen.parse(result.out) : [];
}

export function enumeratorName() {
  return isWindows ? selectWindowsEnumerator().name : "ps";
}

// ---------------------------------------------------------------- termination

export function killPid(pid) {
  if (isWindows) { spawnSync("taskkill", ["/pid", String(pid), "/f"], { windowsHide: true }); return; }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** POSIX: the process group. Windows: `/t`, which walks the parent chain instead. */
export function killGroup(id) {
  if (isWindows) {
    // Awaited, unlike node-process-runner.ts today which fires and forgets.
    spawnSync("taskkill", ["/pid", String(id), "/t", "/f"], { windowsHide: true });
    return;
  }
  try { process.kill(-id, "SIGKILL"); } catch { /* already gone */ }
}

export function isAlive(pid) {
  if (isWindows) {
    const { ok, out } = tryRun("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"]);
    if (!ok) return false;
    // Match the PID COLUMN, not the pid anywhere in the line. tasklist CSV is
    // "image","PID","Session name","Session#","Mem". Searching the whole row for
    // `"<pid>"` would also match the session number — so pid 1 would read alive
    // for as long as anything runs in session 1. A filter that matches nothing
    // prints an informational sentence rather than a CSV row, so a strict
    // column parse also handles the empty case.
    return out.split("\n").some((line) => {
      const columns = line.trim().match(/^"([^"]*)","(\d+)"/);
      return columns !== null && Number(columns[2]) === pid;
    });
  }
  try { process.kill(pid, 0); return true; }
  // EPERM means the pid exists but belongs to someone else — alive, not absent.
  catch (error) { return error.code === "EPERM"; }
}

// ------------------------------------------------------------------ algorithm

export function descendantsOf(table, rootPid) {
  const byParent = new Map();
  for (const row of table) {
    if (row.ppid === null) continue;
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const found = [];
  const queue = [rootPid];
  const seen = new Set([rootPid]);
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (seen.has(child.pid)) continue;   // guard against pid-reuse cycles
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

export const PROCESS_CAPTURE_INTERVAL_MS = 250;
export const PROCESS_VERIFY_SWEEP_INTERVAL_MS = 100;
export const PROCESS_VERIFY_MAX_SWEEPS = 20;

/** Phase 1 — accumulate concrete pids and the distinct groups they belong to. */
export async function capture(rootPid, durationMs, state = { pids: new Map(), groups: new Set() }) {
  state.groups.add(rootPid);
  const deadline = Date.now() + durationMs;
  do {
    for (const row of descendantsOf(enumerate(), rootPid)) {
      state.pids.set(row.pid, row.name ?? "");
      if (row.pgid !== null) state.groups.add(row.pgid);
    }
    if (Date.now() >= deadline) break;
    await sleep(PROCESS_CAPTURE_INTERVAL_MS);
  } while (Date.now() < deadline);
  return state;
}

/** Phases 2 and 3 — kill recorded groups then recorded pids, verify by probe. */
export async function terminateAndVerify(rootPid, state, reason = "abort") {
  const started = process.hrtime.bigint();
  for (const group of state.groups) killGroup(group);
  for (const pid of state.pids.keys()) killPid(pid);
  killPid(rootPid);

  let sweeps = 0;
  let consecutiveEmpty = 0;
  let survivors = [];
  while (sweeps < PROCESS_VERIFY_MAX_SWEEPS) {
    sweeps += 1;
    // Late arrivals still get picked up, so a process that appeared after the
    // last capture poll is not silently excluded from the proof.
    for (const row of descendantsOf(enumerate(), rootPid)) {
      if (!state.pids.has(row.pid)) state.pids.set(row.pid, row.name ?? "");
    }
    survivors = [...state.pids.keys()].filter(isAlive);
    for (const pid of survivors) killPid(pid);
    consecutiveEmpty = survivors.length === 0 ? consecutiveEmpty + 1 : 0;
    if (consecutiveEmpty >= 2) break;
    await sleep(PROCESS_VERIFY_SWEEP_INTERVAL_MS);
  }

  return {
    reason,
    rootPid,
    capturedPids: [...state.pids.keys()],
    capturedGroups: [...state.groups],
    survivors,
    sweeps,
    exhaustive: consecutiveEmpty >= 2,
    elapsedMs: +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1),
  };
}

export { isWindows, sleep };
