import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BridgeCredentialStore } from "@vidcom/adapter";
import { startServing, type ServingDaemon } from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  delete process.env.VIDCOM_APP_DATA;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  budgetMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + budgetMs;
  let text = "";
  while (!text.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`stream never carried ${needle}: ${text}`);
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  return text;
}

describe("an agent write reaches the UI", () => {
  it("delivers a bridge tool write to an open event stream", async () => {
    // The whole point of the bridge: an agent writes through it, and the UI
    // that is already open sees the change without reloading. The watcher and
    // the event outbox from Phase 1 do that work, and this proves the bridge
    // did not route around them.
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-bridge-events-")));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await cp(path.resolve("projects/swiss-grid"), path.join(workspace, "swiss-grid"), {
      recursive: true,
    });
    const appData = path.join(root, "app-data");
    process.env.VIDCOM_APP_DATA = appData;

    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    const daemon = await startServing({ workspace });
    daemons.push(daemon);
    const host = `127.0.0.1:${daemon.listener.port}`;

    const exchange = await fetch(`${daemon.baseUrl}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { Host: host, "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    expect(exchange.status).toBe(204);
    const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();

    const listing = await fetch(`${daemon.baseUrl}/api/v1/projects`, {
      headers: { Host: host, Cookie: cookie! },
    });
    const projects = await listing.json() as { projects?: Array<{ id: string }> };
    const projectId = projects.projects?.[0]?.id;
    expect(projectId, `${listing.status} ${JSON.stringify(projects)} in ${workspace}`).toBeTruthy();

    // The UI is watching before the agent writes, exactly as it would be.
    const stream = await fetch(`${daemon.baseUrl}/api/v1/events`, {
      headers: { Host: host, Cookie: cookie!, "Last-Event-ID": "0" },
    });
    expect(stream.ok).toBe(true);
    const reader = stream.body!.getReader();

    // The bridge bearer is the one the daemon minted for itself during boot.
    const bearer = await new BridgeCredentialStore(appData).read();
    const entry = path.join(workspace, "swiss-grid", "index.html");
    const current = await readFile(entry, "utf8");
    // The write is optimistic-concurrency checked, exactly as any agent write
    // is: the bridge does not get a weaker contract than the local path.
    const expectedContentHash = `sha256:${createHash("sha256").update(current).digest("hex")}`;
    const written = `${current}\n<!-- bridge-write -->\n`;

    try {
      const call = await fetch(`${daemon.baseUrl}/api/bridge/v1/tools/save_file`, {
        method: "POST",
        headers: {
          Host: host,
          Authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: "2026-07-28",
          input: { projectId, path: "index.html", content: written, expectedContentHash },
        }),
      });
      expect(call.status).toBe(200);

      const text = await readUntil(reader, "index.html");
      expect(text).toContain("index.html");

      // A destructive tool still needs a grant a person issued. The bridge
      // cannot elicit one — there is nobody on the other end of a JSON-RPC pipe
      // to ask — so it fails rather than approving itself, which is the only
      // safe way for this to be unavailable.
      const destructive = await fetch(`${daemon.baseUrl}/api/bridge/v1/tools/delete_file`, {
        method: "POST",
        headers: {
          Host: host,
          Authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocolVersion: "2026-07-28",
          input: { projectId, path: "index.html", expectedContentHash },
        }),
      });
      expect(destructive.status).not.toBe(200);
      expect(await readFile(entry, "utf8")).toContain("bridge-write");
    } finally {
      await reader.cancel();
    }
  }, 90_000);
});
