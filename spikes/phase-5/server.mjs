import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const repoRoot = new URL("../../", import.meta.url).pathname;

const VENDOR = {
  "/vendor/hyperframe.runtime.iife.js": join(repoRoot, "node_modules/@hyperframes/core/dist/hyperframe.runtime.iife.js"),
  "/vendor/hyperframes-player.global.js": join(repoRoot, "node_modules/@hyperframes/player/dist/hyperframes-player.global.js"),
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // Strict MIME matters: a stylesheet served as octet-stream parses to zero rules
  // and silently does nothing — cost one debugging round to find.
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export function startSpikeServer(port = 0) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      // Deliberately broken document for the failure-path probes.
      if (path === "/fixture/broken-root.html") {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("boom");
        return;
      }
      // Production-shaped routes: compiled preview doc + raw project files (what the
      // runtime itself fetches for `data-composition-src`, resolved against <base>).
      const file = VENDOR[path]
        ?? (path.startsWith("/project-files/") ? join(here, "project", path.slice("/project-files/".length))
          : path.startsWith("/compiled/") ? join(here, "compiled", path.slice("/compiled/".length))
          : join(here, path.replace(/^\//u, "")));
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startSpikeServer(4599);
  console.log(`spike server on http://127.0.0.1:${port}`);
}
