/**
 * S2, second half — can a Node SEA serve the exported frontend from memory,
 * including a `/projects/<slug>` whose slug did not exist at build time?
 *
 * The export emits exactly one shell (`projects/__shell.html`). Every other
 * `/projects/*` path has to resolve to that shell, and — a detail the goals doc
 * does not cover — so do the RSC payload `.txt` files Next 16 emits beside it,
 * because the client router fetches those on navigation.
 */
import { createServer } from "node:http";
import { getAsset } from "node:sea";

const files = JSON.parse(getAsset("files.json", "utf8"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function contentType(pathname) {
  const dot = pathname.lastIndexOf(".");
  return TYPES[pathname.slice(dot)] ?? "application/octet-stream";
}

/** Maps a request path onto an exported file, falling back to the studio shell. */
export function resolveExported(pathname, has) {
  const direct = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (has(direct)) return { key: direct, via: "direct" };
  if (has(`${direct}.html`)) return { key: `${direct}.html`, via: "implicit-html" };
  const projects = /^\/projects\/([^/]+)(\/.*)?$/u.exec(pathname);
  if (projects) {
    const rest = projects[2];
    // Client-side navigation asks for the RSC payload next to the shell.
    if (rest && has(`projects/__shell${rest}`)) return { key: `projects/__shell${rest}`, via: "shell-rsc" };
    if (!rest) return { key: "projects/__shell.html", via: "shell-html" };
    if (has("projects/__shell.html")) return { key: "projects/__shell.html", via: "shell-html" };
  }
  return null;
}

const has = (key) => Object.hasOwn(files, key);

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/sse") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      response.write(`id: ${n}\nevent: tick\ndata: {"n":${n},"t":${Date.now()}}\n\n`);
      if (n >= 5) {
        clearInterval(timer);
        response.end();
      }
    }, 300);
    request.on("close", () => clearInterval(timer));
    return;
  }
  if (url.pathname === "/upload" && request.method === "POST") {
    let bytes = 0;
    request.on("data", (chunk) => { bytes += chunk.length; });
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ bytes }));
    });
    return;
  }
  const hit = resolveExported(url.pathname, has);
  if (!hit) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
    return;
  }
  response.writeHead(200, { "Content-Type": contentType(hit.key), "X-Served-Via": hit.via });
  response.end(Buffer.from(files[hit.key], "base64"));
});

server.listen(Number(process.env.S2_PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`${JSON.stringify({ port, fileCount: Object.keys(files).length })}\n`);
});
