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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/harness.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(bundle);
      return;
    }
    if (url.pathname === "/missing.js") {
      response.writeHead(404, { "content-type": "text/javascript; charset=utf-8" }).end("missing");
      return;
    }
    if (url.pathname === "/preview") {
      const delay = Number(url.searchParams.get("delay") ?? 0);
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
