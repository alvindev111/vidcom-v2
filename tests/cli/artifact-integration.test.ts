import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MAX_BGM_BYTES } from "@vidcom/contracts";
import { startServing, type ServingDaemon } from "@vidcom/cli";
import { beforeAll, describe, expect, it } from "vitest";
import { writeSampleProject } from "../support/sample-project";

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

let daemon: ServingDaemon;
let host: string;
let cookie: string;
let projectId: string;
let emptyDirectory: string;

async function stopAll(): Promise<void> {
  for (const entry of daemons.splice(0)) await entry.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

beforeAll(async () => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-artifact-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeSampleProject(workspace, { slug: "swiss-grid", id: "project_swiss_grid" });
  // The directory the daemon runs beside. Nothing may appear in it: an artifact
  // that unpacks assets next to itself turns a single file into a folder the
  // user did not ask for and cannot move.
  emptyDirectory = path.join(root, "run-from-here");
  await mkdir(emptyDirectory, { recursive: true });

  process.env.VIDCOM_APP_DATA = path.join(root, "app-data");
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
  daemon = await startServing({ workspace });
  daemons.push(daemon);
  host = `127.0.0.1:${daemon.listener.port}`;

  const exchange = await fetch(`${daemon.baseUrl}/api/v1/auth/exchange`, {
    method: "POST",
    headers: { Host: host, "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const projects = await (await fetch(`${daemon.baseUrl}/api/v1/projects`, {
    headers: { Host: host, Cookie: cookie },
  })).json() as { projects: Array<{ id: string }> };
  projectId = projects.projects[0]!.id;

  return stopAll;
}, 90_000);

describe("the packaged daemon over a real socket", () => {
  it("writes nothing into the directory it was started from", async () => {
    expect(await readdir(emptyDirectory)).toEqual([]);
  });

  it("streams events without a proxy buffering them", async () => {
    // Buffering turns a live UI into one that updates in bursts, or not at all
    // until the connection ends. The header is the only way to say so to a
    // proxy that would otherwise hold the bytes.
    const stream = await fetch(`${daemon.baseUrl}/api/v1/events`, {
      headers: { Host: host, Cookie: cookie, "Last-Event-ID": "0" },
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("x-accel-buffering")).toBe("no");
    await stream.body?.cancel();
  }, 30_000);

  it("carries an upload right up to the limit the route was sized for", async () => {
    // Over a real socket rather than through the app directly: a body limit
    // that only holds for an in-memory Request is not a limit the network path
    // has ever been asked about.
    const response = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/assets/bgm`,
      {
        method: "POST",
        headers: { Host: host, Cookie: cookie, "content-type": "audio/mpeg" },
        body: new Uint8Array(MAX_BGM_BYTES),
      },
    );
    expect(response.status).not.toBe(413);
  }, 60_000);

  it("refuses the byte after it, and says what the limit is", async () => {
    const response = await fetch(
      `${daemon.baseUrl}/api/v1/projects/${projectId}/assets/bgm`,
      {
        method: "POST",
        headers: { Host: host, Cookie: cookie, "content-type": "audio/mpeg" },
        body: new Uint8Array(MAX_BGM_BYTES + 65_537),
      },
    );
    expect(response.status).toBe(413);
    // The shipped code is `too_large`; the checklist prose calls it
    // `payload_too_large`. The wire contract wins — it is already published —
    // and the divergence is recorded rather than renamed.
    expect(await response.json()).toMatchObject({ error: { code: "too_large" } });
  }, 60_000);
});
