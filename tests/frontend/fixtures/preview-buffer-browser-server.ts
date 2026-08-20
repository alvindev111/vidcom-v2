import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildHealthCollectorScript } from "@vidcom/adapter";

const execFileAsync = promisify(execFile);

function previewDocument(url: URL): string {
  const sequence = Number(url.searchParams.get("served") ?? 0);
  const duration = Number(url.searchParams.get("duration") ?? 10);
  const variant = url.searchParams.get("variant") ?? "healthy";
  const nested = variant === "missing-scene" ? "" : "<span>scene loaded</span>";
  const authored = variant === "script-error" ? '<script>throw new Error("authored failure")</script>' : "";
  const resource = variant === "resource-404" ? '<script src="/missing.js"></script>' : "";
  return `<!doctype html><html><head>
<script data-vidcom-health="collector" data-project-revision="${sequence}" data-change-seq="${sequence}">${buildHealthCollectorScript()}</script>
${authored}${resource}</head><body data-duration="${duration}">
<main data-composition-id="root" data-duration="${duration}"><div data-composition-src="scene.html">${nested}</div></main>
</body></html>`;
}

function previewDelay(value: string | null): number {
  if (value === "300") return 300;
  if (value === "180") return 180;
  return 0;
}

export async function startPreviewBufferBrowserFixture(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-preview-browser-"));
  const bundlePath = path.join(scratch, "harness.js");
  const entry = path.resolve("tests/frontend/fixtures/preview-buffer-browser-harness.ts");
  await execFileAsync("bun", ["build", entry, "--target=browser", `--outfile=${bundlePath}`], {
    cwd: process.cwd(),
  });
  const bundle = await readFile(bundlePath);
  // The host pages need the player definition and nothing else from the harness.
  const playerPath = path.join(scratch, "probe-player.js");
  await execFileAsync("bun", [
    "build", path.resolve("tests/frontend/fixtures/preview-buffer-browser-player.ts"),
    "--target=browser", `--outfile=${playerPath}`,
  ], { cwd: process.cwd() });
  const playerBundle = await readFile(playerPath);
  const hostPath = path.join(scratch, "bridge-host.js");
  await execFileAsync("bun", [
    "build", path.resolve("tests/frontend/fixtures/preview-buffer-browser-host.ts"),
    "--target=browser", `--outfile=${hostPath}`,
  ], { cwd: process.cwd() });
  const hostBundle = await readFile(hostPath);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/probe-player.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(playerBundle);
      return;
    }
    if (url.pathname === "/bridge-host.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(hostBundle);
      return;
    }
    if (url.pathname === "/harness.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(bundle);
      return;
    }
    if (url.pathname === "/missing.js") {
      response.writeHead(404, { "content-type": "text/javascript; charset=utf-8" }).end("missing");
      return;
    }
    // Each engine now lives in a host page of its own, because a composition
    // runtime only bridges to a parent that has no preview in it yet. The probe
    // serves the same shape the app's static export does.
    if (url.pathname === "/preview-host.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        .end(`<!doctype html><html><body style="margin:0">
<div data-preview-host style="position:absolute;inset:0"></div>
<script type="module" src="/bridge-host.js"></script>
</body></html>`);
      return;
    }
    if (url.pathname === "/preview") {
      const delay = previewDelay(url.searchParams.get("delay"));
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
          .end(previewDocument(url));
      }, delay);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end('<!doctype html><html><body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("preview browser fixture has no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
