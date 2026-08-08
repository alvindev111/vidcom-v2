import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Temporary measurement for the Windows identity probe, which hangs on CI while
// the same PowerShell binary answers elsewhere. Three fixes aimed at guesses —
// the command budget, the environment allowlist, and WMI — all missed, so this
// times each variable separately instead of assuming which one matters.
// Remove once the cause is fixed.

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20_000;

const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
const powershell = path.win32.join(
  windowsRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const PASSTHROUGH = [
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
];

function restrictedEnvironment() {
  const environment = {
    NODE_ENV: process.env.NODE_ENV,
    SystemRoot: windowsRoot,
    WINDIR: windowsRoot,
    PATH: `${path.win32.dirname(powershell)};${path.win32.join(windowsRoot, "System32")}`,
    PSModulePath: path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
  };
  for (const name of PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

const TRIVIAL = "'ok'";
const GET_PROCESS = `$p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'absent' } else { $p.StartTime.ToUniversalTime().ToString('o') }`;
const GET_CIM = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}"; $p.CreationDate.ToUniversalTime().ToString('o')`;

const cases = [
  { name: "trivial + inherited env + PATH binary", exe: "powershell.exe", command: TRIVIAL, env: undefined },
  { name: "trivial + inherited env + absolute binary", exe: powershell, command: TRIVIAL, env: undefined },
  { name: "trivial + restricted env", exe: powershell, command: TRIVIAL, env: restrictedEnvironment() },
  { name: "Get-Process + inherited env", exe: powershell, command: GET_PROCESS, env: undefined },
  { name: "Get-Process + restricted env", exe: powershell, command: GET_PROCESS, env: restrictedEnvironment() },
  { name: "Get-CimInstance + inherited env", exe: powershell, command: GET_CIM, env: undefined },
  { name: "Get-CimInstance + restricted env", exe: powershell, command: GET_CIM, env: restrictedEnvironment() },
];

function describe(error) {
  if (error?.killed === true || error?.signal) return `TIMEOUT after ${TIMEOUT_MS}ms`;
  return `ERROR ${String(error?.code ?? "")} ${String(error?.message ?? error).slice(0, 160)}`;
}

process.stdout.write(`powershell: ${powershell} (exists: ${existsSync(powershell)})\n`);
process.stdout.write(`inherited env keys: ${Object.keys(process.env).length}\n`);
process.stdout.write(`forwarded present: ${PASSTHROUGH.filter((n) => process.env[n] !== undefined).join(",") || "none"}\n\n`);

for (const item of cases) {
  const started = Date.now();
  try {
    const result = await execFileAsync(item.exe, [
      "-NoProfile", "-NonInteractive", "-Command", item.command,
    ], { encoding: "utf8", timeout: TIMEOUT_MS, env: item.env, windowsHide: true });
    const stderr = result.stderr.trim();
    process.stdout.write(
      `${String(Date.now() - started).padStart(6)}ms  OK       ${item.name}`
      + ` -> ${result.stdout.trim().slice(0, 60)}${stderr ? ` [stderr: ${stderr.slice(0, 80)}]` : ""}\n`,
    );
  } catch (error) {
    process.stdout.write(`${String(Date.now() - started).padStart(6)}ms  ${describe(error)}  ${item.name}\n`);
  }
}
