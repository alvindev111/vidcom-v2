// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getNextHostedRuntime, handleNextHostedRequest } from "@vidcom/cli";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("production browser history wiring", () => {
  it("records a real hosted write in the same history singleton read by the HTTP route", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-history-host-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const project = path.join(workspace, "history-runtime");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "hyperframes.json"), "{}\n");
    await writeFile(path.join(project, "index.html"), '<main data-composition-id="root"></main>\n');
    await writeFile(path.join(project, "vidcom.json"), JSON.stringify({ id: "project_history_runtime" }));
    const nonce = Buffer.alloc(32, 11).toString("base64url");
    const port = 49323;
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
    };
    process.env.VIDCOM_APP_DATA = path.join(root, "app-data");
    process.env.VIDCOM_WORKSPACE = workspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    const host = `127.0.0.1:${port}`;
    const runtime = await getNextHostedRuntime(port);
    const request = (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Host", host);
      return handleNextHostedRequest(new Request(`http://${host}${pathname}`, { ...init, headers }));
    };
    try {
      const exchange = await request("/api/v1/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
      const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
      const ref = (await runtime.foundation.infrastructure.workspace.listProjects())[0]!;
      const studioId = "01K1ABCDEFGHJKMNPQRSTVWXYZ";
      const headers = { Cookie: cookie, "x-vidcom-studio-session": studioId };
      const attached = await request(`/api/v1/projects/${ref.id}/history/session`, { method: "POST", headers });
      expect(attached.status).toBe(204);

      const current = await request(`/api/v1/projects/${ref.id}/files?path=index.html`, { headers: { Cookie: cookie } });
      const file = await current.json() as { file: { content: string; contentHash: string } };
      const written = await request(`/api/v1/projects/${ref.id}/files`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "index.html",
          content: `${file.file.content}<!-- history -->\n`,
          expectedContentHash: file.file.contentHash,
        }),
      });
      expect(written.status).toBe(200);

      const response = await request(`/api/v1/projects/${ref.id}/history`, { headers });
      const state = await response.json();
      expect(state).toMatchObject({ canUndo: true, depth: 1, nextUndoLabel: "Edit source" });
      expect(runtime.foundation.infrastructure.mutationObserver.state(studioId, ref.id)).toEqual(state);
    } finally {
      await runtime.foundation.stop();
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA; else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE; else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE; else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
    }
  }, 30_000);
});
