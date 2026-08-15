import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { BrowseWorkerPool, WorkerFilesystemBrowser } from "@vidcom/adapter";
import { BrowseTokenStore, FilesystemBrowserService } from "@vidcom/core";
import { createSystemRoutes } from "@vidcom/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

const SESSION = "session_a";
const roots: string[] = [];
const browsers: WorkerFilesystemBrowser[] = [];

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scene(options: { authenticated?: boolean } = {}) {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "vidcom-system-routes-")));
  roots.push(root);
  await mkdir(path.join(root, "projects"));
  await writeFile(path.join(root, "notes.txt"), "notes\n", "utf8");

  const adapter = new WorkerFilesystemBrowser(new BrowseWorkerPool(2, 20_000));
  browsers.push(adapter);
  const tokens = new BrowseTokenStore();
  const browser = new FilesystemBrowserService(adapter, tokens);

  const app = new Hono();
  app.route("/v1/system", createSystemRoutes({
    browser,
    sessionId: () => options.authenticated === false ? undefined : SESSION,
    workspace: async () => ({ workspaceRoot: root }),
    runtime: async () => ({ platform: process.platform }),
  }));
  app.onError((error) => new Response(
    JSON.stringify({ error: (error as { detail?: { code?: string } }).detail?.code ?? "unknown" }),
    { status: 400 },
  ));

  const tokenFor = async (target: string): Promise<string> => {
    const identity = await adapter.identity(target);
    if (!identity) throw new Error(`no identity for ${target}`);
    return tokens.mint({ sessionId: SESSION, canonicalPath: target, identity }).token;
  };

  return { root, app, tokenFor };
}

async function post(app: Hono, route: string, body: unknown): Promise<Response> {
  return app.request(`http://127.0.0.1${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("system filesystem routes", () => {
  it("lists roots for an authenticated session", async () => {
    const value = await scene();
    const response = await value.app.request("http://127.0.0.1/v1/system/filesystem/roots");

    expect(response.status).toBe(200);
    const body = await response.json() as { roots: { token: string }[] };
    expect(body.roots.length).toBeGreaterThan(0);
    expect(body.roots[0]?.token).toMatch(/^browse_/u);
  });

  it("refuses to browse without a session", async () => {
    const value = await scene({ authenticated: false });
    const response = await value.app.request("http://127.0.0.1/v1/system/filesystem/roots");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "auth_required" });
  });

  it("takes entry listing as a POST so directory names stay out of the request line", async () => {
    const value = await scene();
    const response = await post(value.app, "/v1/system/filesystem/entries", {
      token: await value.tokenFor(value.root),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { entries: { name: string }[] };
    expect(body.entries.map((entry) => entry.name).sort()).toEqual(["notes.txt", "projects"]);
  });

  it("rejects an unknown field rather than ignoring it", async () => {
    const value = await scene();
    const response = await post(value.app, "/v1/system/filesystem/entries", {
      token: await value.tokenFor(value.root),
      path: "/etc",
    });

    // Strict schemas: a client that still sends a path is told so.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "schema_invalid" });
  });

  it("creates a directory and returns it with a token", async () => {
    const value = await scene();
    const response = await post(value.app, "/v1/system/directories", {
      parentToken: await value.tokenFor(value.root),
      name: "new-project",
    });

    expect(response.status).toBe(201);
    const body = await response.json() as { name: string; token: string };
    expect(body.name).toBe("new-project");
    expect(body.token).toMatch(/^browse_/u);
  });

  it("refuses a directory name that is not a single segment", async () => {
    const value = await scene();
    const response = await post(value.app, "/v1/system/directories", {
      parentToken: await value.tokenFor(value.root),
      name: "../escape",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "path_invalid" });
  });

  it("reports the current workspace and runtime", async () => {
    const value = await scene();

    const workspace = await value.app.request("http://127.0.0.1/v1/system/workspace");
    expect(await workspace.json()).toEqual({ workspaceRoot: value.root });

    const runtime = await value.app.request("http://127.0.0.1/v1/system/runtime");
    expect(await runtime.json()).toEqual({ platform: process.platform });
  });

  it("refuses a forged token instead of reading whatever it names", async () => {
    const value = await scene();
    const response = await post(value.app, "/v1/system/filesystem/entries", {
      token: "browse_forged",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "browse_token_invalid" });
  });
});
