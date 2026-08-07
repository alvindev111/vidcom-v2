/**
 * S4 — đóng OQ-13: shim hay sidecar Node?
 *
 * Bản 3 của Goals cho rằng shim nguy hiểm vì "cha và con cùng một execPath nên
 * luật kill không nhận diện được con". Đọc `process-supervisor.ts` thì luật kill
 * KHÔNG dùng execPath: nó `spawn(detached)` để con có process group riêng, liệt
 * kê `ps -Ao pid=,ppid=,pgid=,lstart=`, lấy hậu duệ của rootPid, giết theo group
 * rồi quét lại xác minh bằng (pid, startedAt).
 *
 * Spike này chạy đúng giao thức đó với cả hai hình dạng spawn để xem giả định
 * kia đúng hay sai — và đo cái giá thật của mỗi bên.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Giống hệt enumerateProcesses() của supervisor. */
async function enumerate() {
  const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8", timeout: 2000,
  });
  return stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], pgid: +m[3], startedAt: m[4].trim() }] : [];
  });
}

function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const r of rows) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r]);
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    for (const child of byParent.get(stack.pop()) ?? []) { out.push(child); stack.push(child.pid); }
  }
  return out;
}

async function run(shape, { artifact, cliPath, nodeBin, projectRoot, outPath, killAfterMs }) {
  const command = shape === "shim"
    ? [artifact, "--vidcom-node", cliPath]
    : [nodeBin, cliPath];
  const args = ["render", projectRoot, "-o", outPath, "--workers", "1", "--quiet", "--best-effort"];

  const started = Date.now();
  // detached: true — đúng như supervisor làm, để con có process group riêng.
  const child = spawn(command[0], [...command.slice(1), ...args], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.SPIKE_HOME,
      HYPERFRAMES_BROWSER_PATH: process.env.HYPERFRAMES_BROWSER_PATH,
      HYPERFRAMES_FFMPEG_PATH: process.env.HYPERFRAMES_FFMPEG_PATH,
      HYPERFRAMES_FFPROBE_PATH: process.env.HYPERFRAMES_FFPROBE_PATH,
    },
  });
  const rootPid = child.pid;
  child.stdout.resume();
  child.stderr.resume();

  const captured = new Map();
  const groups = new Map();
  const capture = async () => {
    const rows = await enumerate();
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    for (const row of [...descendantsOf(rows, rootPid), byPid.get(rootPid)].filter(Boolean)) {
      captured.set(row.pid, row.startedAt);
      const leader = byPid.get(row.pgid);
      if (leader) groups.set(row.pgid, leader.startedAt);
    }
  };

  const timer = setInterval(() => void capture().catch(() => {}), 250);
  await sleep(killAfterMs);
  await capture();
  clearInterval(timer);

  const capturedBeforeKill = [...captured.keys()].length;
  const groupsBeforeKill = [...groups.keys()];

  // Giết theo group, giống killCaptured() của supervisor.
  for (const g of groups.keys()) { try { process.kill(-g, "SIGKILL"); } catch {} }
  try { process.kill(rootPid, "SIGKILL"); } catch {}

  // Quét xác minh: (pid, startedAt) còn khớp nghĩa là còn sống.
  let survivors = [];
  let sweeps = 0;
  let consecutiveEmpty = 0;
  while (sweeps < 20 && consecutiveEmpty < 2) {
    sweeps += 1;
    const rows = await enumerate();
    const current = new Map(rows.map((r) => [r.pid, r.startedAt]));
    survivors = [...captured].filter(([pid, at]) => current.get(pid) === at).map(([pid]) => pid);
    for (const pid of survivors) { try { process.kill(pid, "SIGKILL"); } catch {} }
    consecutiveEmpty = survivors.length === 0 ? consecutiveEmpty + 1 : 0;
    await sleep(100);
  }

  return {
    shape,
    rootPid,
    ms: Date.now() - started,
    capturedBeforeKill,
    groupsBeforeKill,
    survivors,
    sweeps,
    verdict: survivors.length === 0 ? "CLEAN" : "ORPHANS",
  };
}

const cfg = {
  artifact: process.env.SPIKE_ARTIFACT,
  cliPath: process.env.SPIKE_CLI,
  nodeBin: process.env.SPIKE_NODE,
  projectRoot: process.env.SPIKE_PROJECT,
  outPath: process.env.SPIKE_OUT,
  killAfterMs: Number(process.env.SPIKE_KILL_AFTER_MS ?? 25000),
};

const results = [];
for (const shape of ["shim", "sidecar"]) {
  results.push(await run(shape, cfg));
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
