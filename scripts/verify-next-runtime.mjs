import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "vidcom-next-smoke-"));
const workspace = path.join(temporaryRoot, "workspace");
const projectRoot = path.join(workspace, "swiss-grid");
const appData = path.join(temporaryRoot, "app-data");
const nonce = randomBytes(32).toString("base64url");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("could not reserve a port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function eventually(operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await operation(); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error("runtime did not become ready");
}

async function nextEvent(baseUrl, cookie, afterId, expectedPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { Cookie: cookie, "Last-Event-ID": String(afterId) },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE returned ${response.status}`);
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("SSE content type is missing");
    if (response.headers.get("x-accel-buffering") !== "no") throw new Error("SSE buffering guard is missing");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("SSE ended before the expected event");
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const id = Number(frame.match(/^id: (\d+)$/m)?.[1]);
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.type === "file.changed" && event.payload?.path === expectedPath) return id;
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

await cp(path.join(root, "projects", "swiss-grid"), projectRoot, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root,
  env: { ...process.env, VIDCOM_APP_DATA: appData, VIDCOM_WORKSPACE: workspace, VIDCOM_BOOTSTRAP_NONCE: nonce },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error(`Next exited early (${child.exitCode})\n${output}`);
    const response = await fetch(baseUrl);
    if (!response.ok) throw new Error(`Next root returned ${response.status}`);
  });
  const exchange = await fetch(`${baseUrl}/api/v1/auth/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce }),
  });
  if (exchange.status !== 204) throw new Error(`nonce exchange returned ${exchange.status}: ${await exchange.text()}`);
  const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("nonce exchange omitted the session cookie");
  const projectsResponse = await fetch(`${baseUrl}/api/v1/projects`, { headers: { Cookie: cookie } });
  if (!projectsResponse.ok) throw new Error(`project list returned ${projectsResponse.status}`);
  const projects = await projectsResponse.json();
  if (!Array.isArray(projects.projects) || projects.projects.length !== 1) throw new Error("real Next route did not list the selected workspace");

  const entry = path.join(projectRoot, "index.html");
  const firstEvent = nextEvent(baseUrl, cookie, 0, "index.html");
  await writeFile(entry, `${await readFile(entry, "utf8")}\n<!-- runtime-smoke-1 -->\n`);
  const firstId = await firstEvent;
  const resumedEvent = nextEvent(baseUrl, cookie, firstId, "index.html");
  await writeFile(entry, `${await readFile(entry, "utf8")}\n<!-- runtime-smoke-2 -->\n`);
  const secondId = await resumedEvent;
  if (!(secondId > firstId)) throw new Error("Last-Event-ID did not resume after the prior durable event");
  process.stdout.write(`Next runtime smoke passed on port ${port}; SSE ${firstId} -> ${secondId}\n`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  await rm(temporaryRoot, { recursive: true, force: true });
}
