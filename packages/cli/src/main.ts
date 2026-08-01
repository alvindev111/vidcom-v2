#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import { defaultAppDataRoot } from "./next-host";
import { selectWorkspace } from "./workspace-selection";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate loopback port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntilReady(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`VidCom UI exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* listener is not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("VidCom UI did not become ready within 30 seconds");
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: "ignore" });
  opener.unref();
}

export async function runVidcomCli(): Promise<void> {
  const appDataRoot = defaultAppDataRoot();
  const workspaceRoot = await selectWorkspace({
    explicit: argument("--workspace") ?? process.env.VIDCOM_WORKSPACE,
    appDataRoot,
  });
  const port = Number(argument("--port")) || await freePort();
  const nonce = crypto.randomUUID();
  const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VIDCOM_APP_DATA: appDataRoot,
      VIDCOM_WORKSPACE: workspaceRoot,
      VIDCOM_BOOTSTRAP_NONCE: nonce,
    },
    stdio: "inherit",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitUntilReady(baseUrl, child);
    openBrowser(`${baseUrl}/?t=${encodeURIComponent(nonce)}`);
    process.stdout.write(`VidCom is running at ${baseUrl}\n`);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM"
        ? resolve()
        : reject(new Error(`VidCom UI exited with code ${code ?? signal}`)));
      const shutdown = () => child.kill("SIGTERM");
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

if (import.meta.main) {
  runVidcomCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
