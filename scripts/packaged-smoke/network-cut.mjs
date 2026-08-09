import { spawnSync } from "node:child_process";
import net from "node:net";

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

function macCut() {
  const routes = [
    ["-net", "0.0.0.0/1", "127.0.0.1"],
    ["-net", "128.0.0.0/1", "127.0.0.1"],
    ["-inet6", "-net", "::/1", "::1"],
    ["-inet6", "-net", "8000::/1", "::1"],
  ];
  const installed = [];
  try {
    for (const route of routes) {
      unix("route", ["-n", "add", ...route]);
      installed.push(route);
    }
  } catch (error) {
    for (const route of installed.reverse()) {
      try { unix("route", ["-n", "delete", ...route]); } catch { /* retain the first error */ }
    }
    throw error;
  }
  return () => {
    for (const route of installed.reverse()) unix("route", ["-n", "delete", ...route]);
  };
}

function windowsCut() {
  const name = `VidComPackagedSmoke-${process.pid}`;
  const powershell = (script) => command("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ]);
  powershell(
    `New-NetFirewallRule -Name '${name}' -DisplayName '${name}' -Direction Outbound`
      + " -Action Block -RemoteAddress Internet -Profile Any | Out-Null",
  );
  return () => powershell(`Remove-NetFirewallRule -Name '${name}' -ErrorAction Stop`);
}

export function networkCutPlan(platform = process.platform) {
  if (platform === "linux") return "iptables OUTPUT reject except loopback";
  if (platform === "darwin") return "two IPv4 and two IPv6 runner blackhole routes, loopback preserved";
  if (platform === "win32") return "Windows outbound firewall rule for Internet remote addresses";
  throw new Error(`packaged smoke has no runner network cut for ${platform}`);
}

function activate() {
  if (process.platform === "linux") return linuxCut();
  if (process.platform === "darwin") return macCut();
  if (process.platform === "win32") return windowsCut();
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

/** Runs work while the runner network layer blocks external traffic but keeps loopback. */
export async function withRunnerNetworkCut(work) {
  if (process.env.VIDCOM_SMOKE_NETWORK_CUT !== "1") {
    throw new Error("runner network cut is not authorized; set VIDCOM_SMOKE_NETWORK_CUT=1 in the native smoke job");
  }
  const restore = activate();
  try {
    await assertExternalBlocked();
    return await work(networkCutPlan());
  } finally {
    restore();
  }
}
