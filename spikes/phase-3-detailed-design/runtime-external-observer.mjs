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

const resourceRequests = [];
const reports = [];
const resourceServer = createServer((request, response) => {
  resourceRequests.push(request.url ?? "");
  response.writeHead(200, { "content-type": "text/javascript" });
  response.end("globalThis.__VIDCOM_DYNAMIC_SCRIPT_LOADED__ = true;");
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
await Promise.all([listen(resourceServer), listen(reportServer)]);

const scriptUrl = `http://127.0.0.1:${portOf(resourceServer)}/runtime-script.js`;
const reportUrl = `http://127.0.0.1:${portOf(reportServer)}/resource`;
const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-design-resource-observer-"));
const project = path.join(scratch, "warm-grain");
const ownedTemp = path.join(scratch, "render-root");
const output = path.join(scratch, "probe.mp4");

try {
  await cp(path.join(repo, "projects/warm-grain"), project, { recursive: true });
  await mkdir(ownedTemp, { recursive: true });
  const indexPath = path.join(project, "index.html");
  let index = await readFile(indexPath, "utf8");
  index = index
    .replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>/g, "")
    .replace(/url\(\s*["']?https?:\/\/[^)]*\)/gi, "none");
  index = index.replace("</head>", `
    <script>
      const vidcomObservedResources = new Set();
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!/^https?:/.test(entry.name)) continue;
          if (entry.name === ${JSON.stringify(reportUrl)}) continue;
          if (!["script", "link", "css", "font"].includes(entry.initiatorType)) continue;
          const key = entry.initiatorType + "\u0000" + entry.name;
          if (vidcomObservedResources.has(key) || vidcomObservedResources.size >= 100) continue;
          vidcomObservedResources.add(key);
          fetch(${JSON.stringify(reportUrl)}, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: entry.name, initiatorType: entry.initiatorType })
          }).catch(() => {});
        }
      }).observe({ type: "resource", buffered: true });
    </script>
  </head>`);
  await writeFile(indexPath, index, "utf8");

  const compositionPath = path.join(project, "compositions/intro.html");
  let composition = await readFile(compositionPath, "utf8");
  composition = composition.replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>\s*<script>[\s\S]*?<\/script>/, "");
  composition = composition.replace("  </div>\n</template>", `
    <script>
      setTimeout(() => {
        const script = document.createElement("script");
        script.src = ${JSON.stringify(scriptUrl)};
        document.head.appendChild(script);
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
    question: "Can the injected runtime channel observe an external script created dynamically without blocking it?",
    scriptUrl,
    resourceRequests,
    reportCount: reports.length,
    reports: reports.filter((report) => report.url === scriptUrl),
    exitCode,
    observed: reports.some((report) => report.url === scriptUrl && report.initiatorType === "script"),
  }, null, 2));
} finally {
  await Promise.all([close(resourceServer), close(reportServer)]);
  await rm(scratch, { recursive: true, force: true });
}
