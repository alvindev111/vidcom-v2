import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { Client as ModernClient, StreamableHTTPClientTransport as ModernHttp } from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyHttp } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { stopRuntimeChild } from "./runtime-smoke-process.mjs";

const execFile = promisify(execFileCallback);

const root = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "vidcom-next-smoke-"));
const workspace = path.join(temporaryRoot, "workspace");
const projectRoot = path.join(workspace, "swiss-grid");
const appData = path.join(temporaryRoot, "app-data");
const nonce = randomBytes(32).toString("base64url");
const modernRevision = "2026-07-28";

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

function authorizedFetch(secret) {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${secret}`);
    return fetch(input, { ...init, headers });
  };
}

// Tools this smoke insists on seeing, one per level, rather than a total count.
// The exact roster is locked by the tools/list goldens and the registry snapshot;
// a count here only meant every tool addition broke an unrelated script, which is
// how it came to disagree with the registry.
const REQUIRED_TOOLS = ["list_projects", "save_file", "delete_file", "start_tts"];

function assertServesTools(label, tools) {
  const names = tools.map((tool) => tool.name).sort();
  const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`${label} did not serve ${missing.join(", ")}`);
  return names;
}

async function exerciseMcpClients(baseUrl, credential) {
  let legacyTools;
  const legacy = new LegacyClient({ name: "next-runtime-legacy", version: "1.0.0" });
  const legacyTransport = new LegacyHttp(new URL(`${baseUrl}/api/mcp`), {
    fetch: authorizedFetch(credential.secret),
  });
  try {
    await legacy.connect(legacyTransport);
    legacyTools = assertServesTools("legacy entry", (await legacy.listTools()).tools);
    const result = await legacy.callTool({ name: "list_projects", arguments: {} });
    if (result.isError) throw new Error("legacy entry list_projects failed");
  } finally {
    await legacy.close();
  }

  for (const route of [modernRevision, "latest"]) {
    const modern = new ModernClient(
      { name: `next-runtime-modern-${route}`, version: "1.0.0" },
      { versionNegotiation: { mode: { pin: modernRevision } } },
    );
    const transport = new ModernHttp(new URL(`${baseUrl}/api/mcp/${route}`), {
      fetch: authorizedFetch(credential.secret),
    });
    try {
      await modern.connect(transport);
      if (modern.getProtocolEra() !== "modern") throw new Error(`modern ${route} negotiated the wrong era`);
      const modernTools = assertServesTools(`modern ${route}`, (await modern.listTools()).tools);
      // Both eras are served by one Tool Registry, so a route that answers with a
      // different roster means the era split leaked into the tool surface.
      if (modernTools.join(",") !== legacyTools.join(",")) {
        throw new Error(`modern ${route} served a different tool roster than the legacy entry`);
      }
      const result = await modern.callTool({ name: "list_projects", arguments: {} });
      if (result.isError) throw new Error(`modern ${route} list_projects failed`);
    } finally {
      await modern.close();
    }
  }
}

function verifyCredentialAudit(appData, credentialId) {
  const database = new DatabaseSync(path.join(appData, "vidcom.sqlite"), { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT protocol_version AS protocolVersion, detail
      FROM audit_entry
      WHERE action = 'tool:list_projects'
      ORDER BY id
    `).all();
    if (rows.length !== 3) throw new Error(`expected 3 credential-attributed MCP audits, got ${rows.length}`);
    const versions = rows.map((row) => row.protocolVersion);
    if (versions[0] === modernRevision || versions[1] !== modernRevision || versions[2] !== modernRevision) {
      throw new Error(`runtime audit protocol versions are wrong: ${versions.join(",")}`);
    }
    for (const row of rows) {
      const detail = JSON.parse(row.detail);
      if (detail.credentialId !== credentialId) throw new Error("runtime MCP audit lost credential attribution");
    }
  } finally {
    database.close();
  }
}

await cp(path.join(root, "projects", "swiss-grid"), projectRoot, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
// `next start` used to host this. The frontend is a static export now, so Next
// has no server to run and no API to carry: the daemon owns the API, the MCP
// transports and the event stream, which is everything this smoke asserts. The
// host runs under Node, which is what ships, with the loader the MCP suites
// already use to run TypeScript directly. Bun cannot host it: it has no
// `node:sqlite`, which is the database this whole stack is built on.
const host = path.join(root, "scripts", "runtime-smoke-host.mjs");
const tsxLoader = pathToFileURL(
  createRequire(new URL("../packages/cli/package.json", import.meta.url)).resolve("tsx"),
).href;
const child = spawn(process.execPath, ["--import", tsxLoader, host, String(port)], {
  cwd: root,
  env: { ...process.env, VIDCOM_APP_DATA: appData, VIDCOM_WORKSPACE: workspace, VIDCOM_BOOTSTRAP_NONCE: nonce },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error(`host exited early (${child.exitCode})\n${output}`);
    // Readiness is the bound listener, not a route: a request that answers is
    // the next assertion's job, and probing one here would only hide which of
    // the two failed.
    if (!output.includes("listening")) throw new Error(`host has not bound yet\n${output}`);
  });
  const exchange = await fetch(`${baseUrl}/api/v1/auth/exchange`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce }),
  });
  if (exchange.status !== 204) {
    // The captured server output is the only place the cause appears: a 500 here
    // means startup threw inside the route, and the response body is the generic
    // "Internal Server Error" by design.
    throw new Error(
      `nonce exchange returned ${exchange.status}: ${await exchange.text()}\n--- next output ---\n${output}`,
    );
  }
  const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("nonce exchange omitted the session cookie");
  const projectsResponse = await fetch(`${baseUrl}/api/v1/projects`, { headers: { Cookie: cookie } });
  if (!projectsResponse.ok) throw new Error(`project list returned ${projectsResponse.status}`);
  const projects = await projectsResponse.json();
  if (!Array.isArray(projects.projects) || projects.projects.length !== 1) throw new Error("real Next route did not list the selected workspace");

  const cli = path.join(root, "packages", "cli", "bin", "vidcom.mjs");
  const issued = await execFile(process.execPath, [cli, "credential", "issue", "next-runtime-smoke"], {
    cwd: root,
    env: { ...process.env, VIDCOM_APP_DATA: appData },
    encoding: "utf8",
  });
  const credential = JSON.parse(issued.stdout.trim());
  await exerciseMcpClients(baseUrl, credential);
  verifyCredentialAudit(appData, credential.id);

  const entry = path.join(projectRoot, "index.html");
  const firstEvent = nextEvent(baseUrl, cookie, 0, "index.html");
  await writeFile(entry, `${await readFile(entry, "utf8")}\n<!-- runtime-smoke-1 -->\n`);
  const firstId = await firstEvent;
  const resumedEvent = nextEvent(baseUrl, cookie, firstId, "index.html");
  await writeFile(entry, `${await readFile(entry, "utf8")}\n<!-- runtime-smoke-2 -->\n`);
  const secondId = await resumedEvent;
  if (!(secondId > firstId)) throw new Error("Last-Event-ID did not resume after the prior durable event");
  process.stdout.write(`Next runtime smoke passed on port ${port}; MCP legacy + modern exact/latest and credential audit ok; SSE ${firstId} -> ${secondId}\n`);
} finally {
  try {
    await stopRuntimeChild(child);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
