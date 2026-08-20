import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

function command(executable, args) {
  const result = spawnSync(executable, args, {
    env: process.env,
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `runner network command failed: ${executable} ${args.join(" ")} — ${
        result.error?.message ?? result.stderr?.trim() ?? `exit ${String(result.status)}`}`,
    );
  }
}

function unix(executable, args) {
  command("sudo", ["-n", executable, ...args]);
}

function linuxCut() {
  unix("iptables", ["-I", "OUTPUT", "1", "-o", "lo", "-j", "ACCEPT"]);
  try {
    unix("iptables", ["-I", "OUTPUT", "2", "-j", "REJECT"]);
  } catch (error) {
    unix("iptables", ["-D", "OUTPUT", "-o", "lo", "-j", "ACCEPT"]);
    throw error;
  }
  return () => {
    unix("iptables", ["-D", "OUTPUT", "-j", "REJECT"]);
    unix("iptables", ["-D", "OUTPUT", "-o", "lo", "-j", "ACCEPT"]);
  };
}

export function macNetworkCutRoutes() {
  return [
    ["-net", "0.0.0.0/1", "127.0.0.1"],
    ["-net", "128.0.0.0/1", "127.0.0.1"],
    ["-inet6", "-net", "::/1", "::1"],
    ["-inet6", "-net", "8000::/1", "::1"],
  ].map((route) => ({
    // RTF_REJECT makes external requests fail immediately. Routing them to a
    // loopback gateway without this flag can leave Chromium waiting on a
    // connection for the full page-navigation timeout.
    add: [...route, "-reject"],
    delete: route,
  }));
}

function macCut() {
  const routes = macNetworkCutRoutes();
  const installed = [];
  try {
    for (const route of routes) {
      unix("route", ["-n", "add", ...route.add]);
      installed.push(route);
    }
  } catch (error) {
    for (const route of installed.reverse()) {
      try { unix("route", ["-n", "delete", ...route.delete]); } catch { /* retain the first error */ }
    }
    throw error;
  }
  return () => {
    for (const route of installed.reverse()) unix("route", ["-n", "delete", ...route.delete]);
  };
}

export async function windowsNetworkCutPrograms(options = {}) {
  // A machine-wide Windows block also cuts Runner.Worker off from GitHub. Scope
  // the native runner rule to the smoke harness, SEA, and every materialized
  // runtime executable instead; the harness entry proves its own egress is cut.
  const programs = new Map();
  const add = (program) => {
    if (typeof program !== "string" || !path.isAbsolute(program) || program.includes("\0")) {
      throw new Error(`Windows network-cut program must be an absolute path: ${String(program)}`);
    }
    programs.set(program.toLowerCase(), program);
  };
  add(options.harnessProgram ?? process.execPath);
  for (const program of options.programs ?? []) add(program);

  const pending = [...(options.roots ?? [])];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0")) {
      throw new Error(`Windows network-cut root must be an absolute path: ${String(directory)}`);
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(pathname);
      else if (entry.isFile() && /\.exe$/iu.test(entry.name)) add(pathname);
    }
  }
  return [...programs.values()].sort((left, right) => left.localeCompare(right));
}

function windowsCut(programs) {
  const group = `VidComPackagedSmoke-${process.pid}`;
  const powershell = (script) => command("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ]);
  const encodedPrograms = Buffer.from(JSON.stringify(programs), "utf8").toString("base64");
  powershell([
    "$ErrorActionPreference = 'Stop'",
    `$group = '${group}'`,
    `$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPrograms}'))`,
    "[array]$programs = $json | ConvertFrom-Json",
    "try {",
    "  for ($index = 0; $index -lt $programs.Count; $index += 1) {",
    "    $name = $group + '-' + $index",
    "    New-NetFirewallRule -Name $name -DisplayName $name -Group $group -Direction Outbound -Action Block -Program $programs[$index] -RemoteAddress Internet -Profile Any | Out-Null",
    "  }",
    "} catch {",
    "  Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
    "  throw",
    "}",
  ].join("; "));
  return () => powershell(
    `Get-NetFirewallRule -Group '${group}' -ErrorAction Stop | Remove-NetFirewallRule -ErrorAction Stop`,
  );
}

export function networkCutPlan(platform = process.platform) {
  if (platform === "linux") return "iptables OUTPUT reject except loopback";
  if (platform === "darwin") return "two IPv4 and two IPv6 runner reject routes, loopback preserved";
  if (platform === "win32") return "Windows outbound firewall rules for the packaged process set";
  throw new Error(`packaged smoke has no runner network cut for ${platform}`);
}

async function activate(options) {
  if (process.platform === "linux") return linuxCut();
  if (process.platform === "darwin") return macCut();
  if (process.platform === "win32") return windowsCut(await windowsNetworkCutPrograms(options));
  throw new Error(`packaged smoke has no runner network cut for ${process.platform}`);
}

async function assertExternalBlocked() {
  const connected = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "1.1.1.1", port: 443 });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(5_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  if (connected) throw new Error("runner network cut still allowed an external TCP connection");
}

/** Runs work while the native runner blocks smoke-process egress but keeps loopback. */
export async function withRunnerNetworkCut(work, options = {}) {
  if (process.env.VIDCOM_SMOKE_NETWORK_CUT !== "1") {
    throw new Error("runner network cut is not authorized; set VIDCOM_SMOKE_NETWORK_CUT=1 in the native smoke job");
  }
  const restore = await activate(options);
  try {
    await assertExternalBlocked();
    return await work(networkCutPlan());
  } finally {
    restore();
  }
}
