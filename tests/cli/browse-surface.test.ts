import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startServing, type ServingDaemon } from "@vidcom/cli";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
const daemons: ServingDaemon[] = [];

let daemon: ServingDaemon;
let host: string;
let cookie: string;
let secretDirectory: string;

afterEach(() => undefined);

beforeAll(async () => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-browse-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  secretDirectory = path.join(root, "documents");
  await mkdir(secretDirectory, { recursive: true });
  await writeFile(path.join(secretDirectory, "tax-return.pdf"), "x".repeat(4096), "utf8");

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

  return async () => {
    for (const entry of daemons.splice(0)) await entry.stop();
    delete process.env.VIDCOM_APP_DATA;
    await Promise.all(roots.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
  };
}, 90_000);

describe("the browse surface over a real socket", () => {
  it.each([
    ["roots", "/api/v1/system/filesystem/roots", "GET"],
    ["entries", "/api/v1/system/filesystem/entries", "POST"],
  ])("refuses %s without a session, even from loopback", async (_label, route, method) => {
    // Coming from 127.0.0.1 is not authentication. Anything running on the
    // user's machine — a page in their browser, another program — reaches this
    // port, and "local" would let all of it walk the filesystem.
    const response = await fetch(`${daemon.baseUrl}${route}`, {
      method,
      headers: { Host: host, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    expect(response.status).toBe(401);
  }, 30_000);

  it("lists a directory without leaking what is in the files", async () => {
    // Browse exists to pick a folder. Sizes and contents of ordinary files are
    // not needed for that, and a picker that reports them turns a folder
    // chooser into a file reader.
    const roots_ = await (await fetch(`${daemon.baseUrl}/api/v1/system/filesystem/roots`, {
      headers: { Host: host, Cookie: cookie },
    })).json() as { roots: Array<{ path: string }> };
    expect(Array.isArray(roots_.roots)).toBe(true);

    const listing = await fetch(`${daemon.baseUrl}/api/v1/system/filesystem/entries`, {
      method: "POST",
      headers: { Host: host, Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ path: secretDirectory }),
    });
    const text = await listing.text();
    // Whatever the request is answered with, the answer must not carry the
    // bytes of the file or how many of them there are.
    expect(text).not.toContain("xxxx");
    expect(text).not.toContain("4096");
  }, 30_000);
});
