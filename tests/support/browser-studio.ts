import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, constants, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startNextHostedRuntime } from "@vidcom/cli";
import type { Browser, Page } from "puppeteer-core";

import { requireBrowser } from "./browser-harness";
import { writeSampleProject, type SampleProject } from "./sample-project";

/**
 * One real studio in one real browser.
 *
 * The pieces here — a hosted runtime, the built static bundle served beside it,
 * and a Chrome pointed at both — were duplicated inline in the first browser
 * suite. They live here so a second suite can measure the same app rather than
 * a second approximation of it.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function mime(relative: string): string {
  return MIME[path.extname(relative)] ?? "application/octet-stream";
}

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Streams the response through, so an event stream stays a stream. */
async function writeResponse(response: ServerResponse, value: Response): Promise<void> {
  response.statusCode = value.status;
  value.headers.forEach((header, name) => response.setHeader(name, header));
  if (!value.body) {
    response.end();
    return;
  }
  const reader = value.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  response.once("close", cancel);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(Buffer.from(chunk.value));
    }
    response.end();
  } finally {
    response.removeListener("close", cancel);
  }
}

/** One media binary from PATH, or `null` on a machine that has none. */
export async function mediaBinary(name: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const declared = process.env[`HYPERFRAMES_${name.toUpperCase()}_PATH`]?.trim();
  if (declared) return declared;
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, `${name}${suffix}`);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

export interface StudioBrowser {
  page: Page;
  browser: Browser;
  baseUrl: string;
  projectSlug: string;
  projectId: string;
  /** On-disk project, for writes that must come from outside the app. */
  projectRoot: string;
  runtime: Awaited<ReturnType<typeof startNextHostedRuntime>>;
}

/**
 * Runs `scenario` against a studio open on a freshly written sample project.
 *
 * Returns `false` without running anything when this machine has no browser —
 * `requireBrowser` already decides whether that is a skip or a failure.
 */
export async function withStudioBrowser(
  label: string,
  scenario: (studio: StudioBrowser) => Promise<void>,
  prepareProject?: (project: SampleProject) => Promise<void>,
): Promise<boolean> {
  const available = await requireBrowser();
  if (!available.run) {
    process.stdout.write(`${available.message}\n`);
    return false;
  }
  const root = await mkdtemp(path.join(tmpdir(), `vidcom-studio-${label}-`));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  // An id makes the folder an adopted project, and the studio route addresses a
  // project by that id rather than by its folder name.
  const projectId = `project_${label.replace(/[^a-z0-9]+/giu, "_")}`;
  // With a timeline: a preview reload only completes once the runtime has
  // posted one, so a `data-no-timeline` composition could never be measured.
  const project = await writeSampleProject(workspace, {
    slug: label, id: projectId, duration: 8, withTimeline: true,
  });
  await prepareProject?.(project);
  const prior = {
    appData: process.env.VIDCOM_APP_DATA,
    workspace: process.env.VIDCOM_WORKSPACE,
    nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
    settings: process.env.VIDCOM_SETTINGS,
  };
  const nonce = Buffer.alloc(32, 29).toString("base64url");
  process.env.VIDCOM_APP_DATA = path.join(root, "app-data");
  process.env.VIDCOM_WORKSPACE = workspace;
  process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
  process.env.VIDCOM_SETTINGS = path.join(root, "setting.json");
  const ffprobePath = await mediaBinary("ffprobe");
  const ffmpegPath = await mediaBinary("ffmpeg");
  if (ffprobePath) process.env.HYPERFRAMES_FFPROBE_PATH = ffprobePath;
  if (ffmpegPath) process.env.HYPERFRAMES_FFMPEG_PATH = ffmpegPath;

  let runtime: Awaited<ReturnType<typeof startNextHostedRuntime>> | null = null;
  let browser: Browser | null = null;
  let server: ReturnType<typeof createServer> | null = null;
  try {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("browser harness did not reserve a port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    runtime = await startNextHostedRuntime(port, workspace);
    const baseUrl = `http://127.0.0.1:${port}`;
    server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", baseUrl);
        if (requestUrl.pathname.startsWith("/api/")) {
          const bytes = await bodyOf(request);
          await writeResponse(response, await runtime!.app.request(new Request(requestUrl, {
            method: request.method,
            headers: request.headers as HeadersInit,
            ...(bytes.byteLength === 0 ? {} : { body: Uint8Array.from(bytes).buffer }),
          })));
          return;
        }
        const relative = requestUrl.pathname === "/"
          ? "index.html"
          : /^\/projects\/[^/]+$/u.test(requestUrl.pathname)
            ? "projects/__shell.html"
            : requestUrl.pathname.slice(1);
        const contents = await readFile(path.join(process.cwd(), "out", relative));
        response.writeHead(200, { "content-type": mime(relative) });
        response.end(contents);
      } catch {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));

    const puppeteer = await import("puppeteer-core");
    browser = await puppeteer.launch({
      executablePath: available.chromePath,
      headless: true,
      userDataDir: path.join(root, "chrome-profile"),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    if (process.env.VIDCOM_BROWSER_DIAGNOSTICS === "1") {
      page.on("console", (message) => process.stdout.write(`browser console: ${message.type()} ${message.text()}\n`));
      page.on("pageerror", (error) => process.stdout.write(
        `browser pageerror: ${error instanceof Error ? error.message : String(error)}\n`,
      ));
      page.on("requestfailed", (request) => process.stdout.write(
        `browser requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}\n`,
      ));
    }
    await page.goto(`${baseUrl}/?t=${encodeURIComponent(nonce)}`, { waitUntil: "networkidle0" });
    await page.goto(`${baseUrl}/projects/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-timeline-viewport]", { timeout: 30_000 }).catch(async (cause) => {
      const state = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 600) }));
      throw new Error(`studio did not open: ${JSON.stringify(state)}`, { cause });
    });
    await scenario({ page, browser, baseUrl, projectSlug: project.slug, projectId, projectRoot: project.root, runtime });
    return true;
  } finally {
    await browser?.close().catch(() => undefined);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await runtime?.foundation.stop().catch(() => undefined);
    for (const [key, value] of [
      ["VIDCOM_APP_DATA", prior.appData],
      ["VIDCOM_WORKSPACE", prior.workspace],
      ["VIDCOM_BOOTSTRAP_NONCE", prior.nonce],
      ["VIDCOM_SETTINGS", prior.settings],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}
