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

const GET_PROCESS = `$p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'absent' } else { $p.StartTime.ToUniversalTime().ToString('o') }`;

// PowerShell itself starts fine under the restricted environment (216ms) while
// any process-inspecting cmdlet hangs, with both .NET and WMI. So one missing
// variable is responsible; this bisects which.
function withOverrides(overrides) {
  const environment = restrictedEnvironment();
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

const IDENTITY_NAMES = ["USERNAME", "USERDOMAIN", "COMPUTERNAME", "ALLUSERSPROFILE"];
const identityOverrides = Object.fromEntries(
  IDENTITY_NAMES.map((name) => [name, process.env[name]]).filter(([, value]) => value !== undefined),
);

const cases = [
  { name: "baseline restricted", command: GET_PROCESS, env: restrictedEnvironment() },
  { name: "trivial + restricted (control)", command: "'ok'", env: restrictedEnvironment() },
  { name: "restricted + inherited PSModulePath", command: GET_PROCESS, env: withOverrides({ PSModulePath: process.env.PSModulePath }) },
  { name: "restricted, PSModulePath deleted", command: GET_PROCESS, env: withOverrides({ PSModulePath: undefined }) },
  { name: "restricted, PSModulePath empty", command: GET_PROCESS, env: withOverrides({ PSModulePath: "" }) },
  { name: "restricted + inherited PATH", command: GET_PROCESS, env: withOverrides({ PATH: process.env.PATH }) },
  { name: `restricted + ${IDENTITY_NAMES.join("/")}`, command: GET_PROCESS, env: withOverrides(identityOverrides) },
  { name: "restricted + PROCESSOR/NUMBER_OF_PROCESSORS", command: GET_PROCESS, env: withOverrides({
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
  }) },
  { name: "inherited env (control)", command: GET_PROCESS, env: undefined },
].map((item) => ({ ...item, exe: powershell }));

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
