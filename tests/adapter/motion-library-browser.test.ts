import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import puppeteer, { type Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCompositionDocument,
  injectRuntimeAssetGuardDocument,
  mimeFromPath,
  NodeModulesMotionLibraryFiles,
} from "@vidcom/adapter";
import type { ProjectId, RelPath } from "@vidcom/contracts";
import {
  DEFAULT_PREVIEW_SETTINGS,
  findMotionLibrary,
  motionLibraryImportSpecifier,
  motionLibraryScriptTag,
  type AbsolutePath,
  type ProjectRef,
} from "@vidcom/core";

/**
 * Any Chromium-family browser proves what this suite asks: that the vendored
 * files resolve and execute. Edge is checked too because it ships on every
 * Windows install, which is where a developer most often has no Chrome.
 */
function chromiumExecutable(): string | null {
  const fromEnvironment = process.env.HYPERFRAMES_BROWSER_PATH?.trim();
  if (fromEnvironment && existsSync(fromEnvironment)) return fromEnvironment;
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : process.platform === "win32"
      ? [
          path.join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
          path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft/Edge/Application/msedge.exe"),
          path.join(process.env.PROGRAMFILES ?? "", "Microsoft/Edge/Application/msedge.exe"),
        ]
      : [
          "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
          "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge",
        ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("test server has no port"));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const forceClose = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, 2_000);
    server.close(() => {
      clearTimeout(forceClose);
      resolve();
    });
    server.closeIdleConnections();
  });
}

const gsap = findMotionLibrary("gsap")!;
const three = findMotionLibrary("three")!;
const executablePath = chromiumExecutable();
if (!executablePath) console.warn("SKIPPING motion-library browser integration: no Chromium-family browser found");

/**
 * Serves a staged project the way the preview route does: a document plus its
 * project-relative files, over the extension MIME allowlist.
 */
async function stageProject(): Promise<{ root: string; html: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-motion-browser-"));
  const files = new NodeModulesMotionLibraryFiles();
  for (const library of [gsap, three]) {
    const read = await files.read(library);
    if (!read.ok) throw new Error(`motion library unavailable: ${JSON.stringify(read.error)}`);
    for (const file of read.value) {
      await mkdir(path.dirname(path.join(root, file.projectPath)), { recursive: true });
      await writeFile(path.join(root, file.projectPath), file.content);
    }
  }
  await writeFile(path.join(root, "hyperframes.json"), "{}\n");
  // Exactly the shape the skill tells an agent to author: vendored tags, an
  // import of the module library's specifier, and one paused registered timeline.
  await writeFile(path.join(root, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8">
${motionLibraryScriptTag(gsap)}
</head><body>
<main id="root" data-composition-id="root" data-width="640" data-height="360" data-fps="30" data-duration="2">
  <h1 id="title" class="clip" data-start="0" data-duration="2" data-track-index="0">Hello</h1>
</main>
<script>
  const timeline = gsap.timeline({ paused: true });
  timeline.fromTo("#title", { opacity: 0 }, { opacity: 1, duration: 2, ease: "none" }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines.root = timeline;
  window.__probe = { gsap: typeof window.gsap };
</script>
<script type="module">
  import * as THREE from ${JSON.stringify(motionLibraryImportSpecifier(three))};
  const renderer = { scene: new THREE.Scene() };
  window.__probe.three = {
    scene: renderer.scene.type,
    // Reading a symbol that lives in the sibling core file proves both vendored
    // files loaded, not just the module half.
    vector: new THREE.Vector3(1, 2, 3).length(),
  };
</script>
</body></html>
`);
  const ref: ProjectRef = {
    id: "project_motion_browser" as ProjectId,
    slug: "motion-browser",
    root: root as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  const html = await buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, {
    mode: "preview",
    projectRevision: 0,
    changeSeq: 0,
    root: true,
    runtimeUrl: "/runtime.js",
    fileBaseUrl: "/files/",
  });
  return { root, html };
}

describe.skipIf(!executablePath)("vendored motion libraries in a real browser", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: executablePath!,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }, 30_000);

  afterAll(async () => { await browser?.close(); });

  it("loads both a global and a module library from assets/vendor and seeks the timeline", async () => {
    const { root, html } = await stageProject();
    const served: string[] = [];
    const missing: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/" || url.pathname === "/preview") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
        return;
      }
      if (url.pathname === "/runtime.js") {
        response.writeHead(200, { "content-type": "text/javascript" }).end("/* runtime stub */");
        return;
      }
      const relative = url.pathname.startsWith("/files/") ? url.pathname.slice("/files/".length) : null;
      const mime = relative ? mimeFromPath(relative) : null;
      const target = relative ? path.join(root, relative) : null;
      if (!relative || !mime || !target || !existsSync(target)) {
        // The browser asks for a favicon on its own; only document-driven
        // requests say anything about whether the vendored paths resolve.
        if (url.pathname !== "/favicon.ico") missing.push(url.pathname);
        response.writeHead(404).end();
        return;
      }
      served.push(relative);
      const { readFile } = await import("node:fs/promises");
      response.writeHead(200, { "content-type": mime }).end(await readFile(target));
    });
    const port = await listen(server);
    const page = await browser.newPage();
    const offsite: string[] = [];
    page.on("request", (request) => {
      if (!request.url().startsWith(`http://127.0.0.1:${port}`) && !request.url().startsWith("data:")) {
        offsite.push(request.url());
      }
    });
    try {
      const failures: string[] = [];
      page.on("pageerror", (error: unknown) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
      await page.goto(`http://127.0.0.1:${port}/preview`, { waitUntil: "networkidle0" });

      const probe = await page.evaluate(() => (globalThis as unknown as {
        __probe?: { gsap?: string; three?: { scene?: string; vector?: number } };
      }).__probe);
      expect(failures, failures.join(" | ")).toEqual([]);
      expect(missing, `404s: ${missing.join(", ")}`).toEqual([]);
      expect(probe?.gsap).toBe("object");
      expect(probe?.three?.scene).toBe("Scene");
      expect(probe?.three?.vector).toBeCloseTo(Math.sqrt(14), 6);

      // Every vendored file was actually fetched, including the Three.js sibling
      // that only the module's own import resolves.
      expect(served).toContain(gsap.entry);
      for (const file of three.files) expect(served).toContain(file.projectPath);

      // The render seeks; it never plays. A paused timeline must therefore be
      // registered and must move the DOM when seeked.
      const opacities = await page.evaluate(async () => {
        const timeline = (globalThis as unknown as {
          __timelines: Record<string, { pause(): void; seek(time: number): void; paused(): boolean }>;
        }).__timelines.root;
        const read = () => Number(getComputedStyle(document.querySelector("#title")!).opacity);
        const wasPaused = timeline.paused();
        timeline.seek(0);
        const atZero = read();
        timeline.seek(2);
        const atEnd = read();
        return { wasPaused, atZero, atEnd };
      });
      expect(opacities.wasPaused).toBe(true);
      expect(opacities.atZero).toBeLessThan(0.05);
      expect(opacities.atEnd).toBeGreaterThan(0.95);

      // Nothing reached for the network: this is what makes the render
      // reproducible and what keeps it working in a packaged offline app.
      expect(offsite, offsite.join(", ")).toEqual([]);
    } finally {
      await page.close();
      await close(server);
    }
  }, 60_000);

  it("survives the render-time CSP and reports no external dependency", async () => {
    const { root, html } = await stageProject();
    // The render injects a CSP plus a reporting bootstrap; a vendored library
    // must execute under it, and a CDN one would be reported instead.
    const guarded = injectRuntimeAssetGuardDocument(html, {
      csp: "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src *",
      bootstrapScript: "globalThis.__guardBootstrapped = true;",
    });
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/preview") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(guarded);
        return;
      }
      if (url.pathname === "/runtime.js") {
        response.writeHead(200, { "content-type": "text/javascript" }).end("/* runtime stub */");
        return;
      }
      const relative = url.pathname.startsWith("/files/") ? url.pathname.slice("/files/".length) : null;
      const target = relative ? path.join(root, relative) : null;
      const mime = relative ? mimeFromPath(relative) : null;
      if (!relative || !mime || !target || !existsSync(target)) {
        response.writeHead(404).end();
        return;
      }
      const { readFile } = await import("node:fs/promises");
      response.writeHead(200, { "content-type": mime }).end(await readFile(target));
    });
    const port = await listen(server);
    const page = await browser.newPage();
    try {
      const failures: string[] = [];
      page.on("pageerror", (error: unknown) => {
        failures.push(error instanceof Error ? error.message : String(error));
      });
      await page.goto(`http://127.0.0.1:${port}/preview`, { waitUntil: "networkidle0" });
      const state = await page.evaluate(() => ({
        bootstrapped: (globalThis as unknown as { __guardBootstrapped?: boolean }).__guardBootstrapped === true,
        gsap: typeof (globalThis as unknown as { gsap?: unknown }).gsap,
        three: (globalThis as unknown as { __probe?: { three?: { scene?: string } } }).__probe?.three?.scene,
      }));
      expect(failures, failures.join(" | ")).toEqual([]);
      expect(state).toEqual({ bootstrapped: true, gsap: "object", three: "Scene" });
    } finally {
      await page.close();
      await close(server);
    }
  }, 60_000);
});
