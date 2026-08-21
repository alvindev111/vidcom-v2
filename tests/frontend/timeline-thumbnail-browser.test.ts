import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startNextHostedRuntime } from "@vidcom/cli";
import { createScene, getStudioSnapshot } from "@vidcom/core";
import type { Browser } from "puppeteer-core";
import { describe, expect, it } from "vitest";

import { TIMELINE_GUTTER_PX } from "../../src/components/studio/timeline-constants";
import { planTimelineThumbnailCells } from "../../src/lib/studio/timeline-thumbnail-layout";
import { requireBrowser } from "../support/browser-harness";

const SCENE_DURATION_SECONDS = 4;

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function mime(filename: string): string {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filename.endsWith(".css")) return "text/css; charset=utf-8";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

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
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      response.write(Buffer.from(chunk.value));
    }
    response.end();
  } finally {
    response.removeListener("close", cancel);
  }
}

/**
 * Real-browser evidence for R10.9: a clip far wider than the lane may only
 * mount the cells inside `viewport ± 1 viewport`. The arithmetic lives in the
 * pure planner, so this case measures the rendered DOM against that planner for
 * the lane geometry the browser actually laid out.
 */
describe("timeline thumbnail virtualization in a real browser", () => {
  it("mounts only viewport-adjacent cells for a clip wider than five viewports", async () => {
    const available = await requireBrowser();
    if (!available.run) {
      process.stdout.write(`${available.message}\n`);
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-thumbnail-browser-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
      settings: process.env.VIDCOM_SETTINGS,
    };
    const nonce = Buffer.alloc(32, 17).toString("base64url");
    process.env.VIDCOM_APP_DATA = path.join(root, "app-data");
    process.env.VIDCOM_WORKSPACE = workspace;
    process.env.VIDCOM_BOOTSTRAP_NONCE = nonce;
    process.env.VIDCOM_SETTINGS = path.join(root, "setting.json");
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
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1_024, height: 768 });
      await page.goto(`${baseUrl}/?t=${encodeURIComponent(nonce)}`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.body.textContent?.includes("Projects") === true);
      const newVideo = await page.$$("button");
      for (const button of newVideo) {
        if ((await button.evaluate((node) => node.textContent?.trim() ?? "")) === "New video") {
          await button.click();
          break;
        }
      }
      await page.locator('[role="dialog"] input').fill("Thumbnail Virtualization");
      for (const button of await page.$$('[role="dialog"] button')) {
        if ((await button.evaluate((node) => node.textContent?.trim() ?? "")) === "Create video") {
          await button.click();
          break;
        }
      }
      await page.waitForFunction(() => location.pathname.startsWith("/projects/"));
      const created = (await runtime.foundation.application.scanWorkspace())
        .find((entry) => entry.kind === "project" && entry.slug === "thumbnail-virtualization");
      if (!created || created.kind !== "project" || !created.projectId) {
        throw new Error("browser-created project was not discoverable by immutable id");
      }
      const projectId = created.projectId;
      const snapshot = await getStudioSnapshot(runtime.foundation.application.readDependencies, projectId);
      if (!snapshot.ok) throw new Error(`studio snapshot failed: ${JSON.stringify(snapshot.error)}`);
      const seeded = await createScene(runtime.foundation.application.writeDependencies, {
        projectId,
        title: "Wide scene",
        duration: SCENE_DURATION_SECONDS,
        expectedContentHash: snapshot.value.fileHashes[snapshot.value.entryFile.path] ?? null,
      }, "system");
      if (!seeded.ok) throw new Error(`scene seed failed: ${JSON.stringify(seeded.error)}`);
      const sceneId = seeded.value.scene.id;

      await page.goto(`${baseUrl}/projects/${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`[data-timeline-scene-id="${sceneId}"]`);
      await page.waitForSelector("[data-timeline-viewport]");
      for (let step = 0; step < 3; step += 1) {
        await page.click('[aria-label="Zoom in"]');
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
      }

      const measure = async (sceneKey: string) => page.evaluate((id) => {
        const viewport = document.querySelector<HTMLElement>("[data-timeline-viewport]");
        const clip = document.querySelector<HTMLElement>(`[data-timeline-scene-id="${id}"] button`)
          ?? document.querySelector<HTMLElement>(`[data-timeline-scene-id="${id}"]`);
        if (!viewport || !clip) throw new Error("timeline lane geometry was not rendered");
        return {
          scrollLeftPx: viewport.scrollLeft,
          clientWidthPx: viewport.clientWidth,
          clipWidthPx: clip.getBoundingClientRect().width,
          cells: [...document.querySelectorAll<HTMLElement>(
            `[data-timeline-scene-id="${id}"] [data-thumbnail-cell]`,
          )].map((node) => Number(node.dataset.thumbnailCell)),
        };
      }, sceneKey);

      const expected = (sample: Awaited<ReturnType<typeof measure>>) => planTimelineThumbnailCells({
        sceneStartSeconds: 0,
        durationSeconds: SCENE_DURATION_SECONDS,
        pixelsPerSecond: sample.clipWidthPx / SCENE_DURATION_SECONDS,
        viewportStartPx: sample.scrollLeftPx,
        viewportWidthPx: sample.clientWidthPx - TIMELINE_GUTTER_PX,
      }).map((cell) => cell.index);

      const zoomed = await measure(sceneId);
      const laneWidthPx = zoomed.clientWidthPx - TIMELINE_GUTTER_PX;
      const total = Math.ceil(zoomed.clipWidthPx / 80);
      expect(zoomed.clipWidthPx / laneWidthPx).toBeGreaterThan(5);
      expect(zoomed.cells.length).toBeGreaterThan(1);
      expect(total).toBeGreaterThan(zoomed.cells.length);
      expect(zoomed.cells).toEqual(expected(zoomed));
      expect(zoomed.cells.length).toBeLessThan(total / 2);
      expect(Math.max(...zoomed.cells) * 80).toBeLessThanOrEqual(zoomed.scrollLeftPx + laneWidthPx * 2);

      await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>("[data-timeline-viewport]");
        if (viewport) viewport.scrollLeft = Math.round(viewport.scrollWidth / 2);
      });
      await page.waitForFunction((first: number) => {
        const rendered = [...document.querySelectorAll<HTMLElement>("[data-thumbnail-cell]")]
          .map((node) => Number(node.dataset.thumbnailCell));
        return rendered.length > 0 && Math.min(...rendered) > first;
      }, { timeout: 10_000 }, Math.min(...zoomed.cells));

      const scrolled = await measure(sceneId);
      expect(scrolled.scrollLeftPx).toBeGreaterThan(zoomed.scrollLeftPx);
      expect(scrolled.cells.length).toBeGreaterThan(1);
      expect(scrolled.cells).toEqual(expected(scrolled));
      expect(scrolled.cells.length).toBeLessThan(total / 2);
      expect(Math.min(...scrolled.cells) * 80)
        .toBeGreaterThanOrEqual(scrolled.scrollLeftPx - laneWidthPx - 80);
      await page.close();
    } finally {
      await browser?.close();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await runtime?.foundation.stop();
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE;
      else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.settings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = prior.settings;
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
