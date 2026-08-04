import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const ffmpegDir = process.argv[2];
if (!ffmpegDir) throw new Error("pass the portable FFmpeg/FFprobe directory as argv[2]");

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const portOf = (server) => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a port");
  return address.port;
};
const close = (server) => new Promise((resolve) => server.close(resolve));

const assetRequests = [];
const reports = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const assetServer = createServer((request, response) => {
  assetRequests.push(request.url ?? "");
  response.writeHead(200, { "content-type": "image/png", "content-length": png.byteLength });
  response.end(png);
});
const reportServer = createServer((request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try { reports.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { reports.push({ parseError: true }); }
    response.writeHead(204).end();
  });
});
await Promise.all([listen(assetServer), listen(reportServer)]);

const assetUrl = `http://127.0.0.1:${portOf(assetServer)}/runtime-only.png`;
const reportUrl = `http://127.0.0.1:${portOf(reportServer)}/violation`;
const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-design-csp-guard-"));
const project = path.join(scratch, "warm-grain");
const ownedTemp = path.join(scratch, "render-root");
const output = path.join(scratch, "staged.mp4");

try {
  await cp(path.join(repo, "projects/warm-grain"), project, { recursive: true });
  await mkdir(ownedTemp, { recursive: true });

  const indexPath = path.join(project, "index.html");
  let index = await readFile(indexPath, "utf8");
  index = index
    .replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>/g, "")
    .replace(/url\(\s*["']?https?:\/\/[^)]*\)/gi, "none");
  const guard = `
    <meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src ${reportUrl}">
    <script>
      addEventListener("securitypolicyviolation", (event) => {
        fetch(${JSON.stringify(reportUrl)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blockedURI: event.blockedURI, directive: event.effectiveDirective })
        }).catch(() => {});
      });
    </script>`;
  index = index.replace("<meta charset=\"UTF-8\">", `<meta charset="UTF-8">${guard}`);
  await writeFile(indexPath, index, "utf8");

  const compositionPath = path.join(project, "compositions/intro.html");
  let composition = await readFile(compositionPath, "utf8");
  composition = composition.replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>\s*<script>[\s\S]*?<\/script>/, "");
  composition = composition.replace("  </div>\n</template>", `
    <script>
      setTimeout(() => {
        const image = new Image();
        image.src = ${JSON.stringify(assetUrl)};
        document.body.appendChild(image);
      }, 25);
    </script>
  </div>
</template>`);
  await writeFile(compositionPath, composition, "utf8");

  const child = spawn(process.execPath, [
    path.join(repo, "node_modules/hyperframes/bin/hyperframes.mjs"),
    "render", project,
    "-c", "compositions/intro.html",
    "-o", output,
    "--quality", "draft",
    "--workers", "1",
    "--quiet",
  ], {
    cwd: repo,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: `${ffmpegDir};${process.env.PATH ?? ""}`,
      HYPERFRAMES_FFMPEG_PATH: path.join(ffmpegDir, "ffmpeg.exe"),
      HYPERFRAMES_FFPROBE_PATH: path.join(ffmpegDir, "ffprobe.exe"),
      TEMP: ownedTemp,
      TMP: ownedTemp,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log(JSON.stringify({
    question: "Can an injected CSP block runtime-only remote media and report it through a VidCom-owned loopback channel during the actual CLI render?",
    assetUrl,
    assetRequests,
    violationReports: reports,
    hyperframesExitCode: exitCode,
    guardBlockedDownload: assetRequests.length === 0,
    guardReportedViolation: reports.some((report) => report.blockedURI === assetUrl && report.directive === "img-src"),
  }, null, 2));
} finally {
  await Promise.all([close(assetServer), close(reportServer)]);
  await rm(scratch, { recursive: true, force: true });
}

