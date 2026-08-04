import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../..");
const ffmpegDir = process.argv[2];
if (!ffmpegDir) throw new Error("pass the portable FFmpeg/FFprobe directory as argv[2]");

const scratch = await mkdtemp(path.join(tmpdir(), "vidcom-design-remote-media-"));
const project = path.join(scratch, "warm-grain");
const ownedTemp = path.join(scratch, "render-root");
const output = path.join(scratch, "probe.mp4");
const requests = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const server = createServer((request, response) => {
  requests.push(request.url ?? "");
  response.writeHead(200, { "content-type": "image/png", "content-length": png.byteLength });
  response.end(png);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("loopback server did not expose a port");
const remoteUrl = `http://127.0.0.1:${address.port}/runtime-only.png`;

try {
  await cp(path.join(repo, "projects/warm-grain"), project, { recursive: true });
  await mkdir(ownedTemp, { recursive: true });
  const compositionPath = path.join(project, "compositions/intro.html");
  let html = await readFile(compositionPath, "utf8");
  html = html.replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>\s*<script>[\s\S]*?<\/script>/, "");
  html = html.replace("  </div>\n</template>", `
    <script>
      setTimeout(() => {
        const image = new Image();
        image.alt = "runtime-only-probe";
        image.src = ${JSON.stringify(remoteUrl)};
        document.body.appendChild(image);
      }, 25);
    </script>
  </div>
</template>`);
  await writeFile(compositionPath, html, "utf8");

  const staticallyVisible = /<(?:img|video|audio|source)\b[^>]*\bsrc=["']https?:\/\//i.test(html)
    || /url\(\s*["']?https?:\/\//i.test(html);
  const stdout = [];
  const stderr = [];
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const combined = `${stdout.join("")}\n${stderr.join("")}`;

  console.log(JSON.stringify({
    question: "Can a media URL created only at browser runtime bypass the Design v1 static scanner and the HyperFrames CLI contract?",
    remoteUrl,
    staticallyVisibleToProposedScanner: staticallyVisible,
    loopbackRequestsObserved: requests,
    hyperframesExitCode: exitCode,
    hyperframesReportedUrl: combined.includes(remoteUrl),
    conclusion: requests.length > 0 && !staticallyVisible
      ? "The runtime-only media request bypasses static HTML/CSS scanning; CLI stdout is not an enforcement seam."
      : "The probe did not establish the expected runtime-only gap.",
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
