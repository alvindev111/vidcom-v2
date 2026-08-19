import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, constants, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startNextHostedRuntime } from "@vidcom/cli";
import { createScene, getStudioSnapshot, setSceneTiming } from "@vidcom/core";
import type { Browser, Page } from "puppeteer-core";
import { browserAvailability, browserIsRequired, requireBrowser } from "../support/browser-harness";
import { describe, expect, it } from "vitest";

/** A real 1×1 PNG the drop scenario hands to the browser. */
const DROPPED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Locates one media binary on PATH.
 *
 * `null` means this machine has none, which is a skip for a developer and a
 * failure on CI, where `VIDCOM_REQUIRE_BROWSER` says the heavy dependencies are
 * installed on purpose.
 */
async function mediaBinaryPath(name: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const declared = process.env[`HYPERFRAMES_${name.toUpperCase()}_PATH`]?.trim();
  if (declared) return declared;
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, `${name}${suffix}`);
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  if (process.env.VIDCOM_REQUIRE_BROWSER === "1") {
    throw new Error(`${name} must be installed where the browser session suite is required`);
  }
  return null;
}

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

async function clickText(page: Page, selector: string, text: string): Promise<void> {
  const elements = await page.$$(selector);
  for (const element of elements) {
    const content = await element.evaluate((node) => node.textContent?.trim() ?? "");
    if (content.includes(text)) {
      await element.click();
      return;
    }
  }
  throw new Error(`${selector} containing ${text} was not found`);
}

async function appendSourceAndSave(page: Page, marker: string): Promise<void> {
  try {
    await page.waitForSelector(".cm-content", { timeout: 10_000 });
  } catch (cause) {
    const state = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1_000) }));
    throw new Error(`source editor did not mount: ${JSON.stringify(state)}`, { cause });
  }
  const current = await page.$eval(".cm-content", (element) => element.textContent ?? "");
  await page.locator(".cm-content").fill(`${current}\n<!-- ${marker} -->`);
  await page.waitForFunction(() => [...document.querySelectorAll("button")]
    .some((button) => button.textContent?.includes("Save") && !button.hasAttribute("disabled")));
  await clickText(page, "button", "Save");
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Undo Edit source"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
}

async function dragTimelineClip(
  page: Page,
  zone: "body" | "trim-end",
  finish: "drop" | "escape",
  sceneId?: string,
): Promise<void> {
  const selector = sceneId
    ? `[data-timeline-scene-id="${sceneId}"]`
    : "[data-timeline-scene-id]";
  const clip = await page.waitForSelector(selector);
  if (!clip) throw new Error("timeline clip did not mount");
  await clip.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const box = await clip.boundingBox();
  if (!box) throw new Error("timeline clip has no browser geometry");
  const x = zone === "body" ? box.x + box.width / 2 : box.x + box.width - 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 24, y);
  if (finish === "escape") await page.keyboard.press("Escape");
  await page.mouse.up();
}

async function dragReorderHandle(page: Page, sourceSelector: string, targetSelector: string): Promise<boolean> {
  const source = await page.waitForSelector(sourceSelector);
  const target = await page.waitForSelector(targetSelector);
  const sourceBox = await source?.boundingBox();
  const targetBox = await target?.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("reorder handle has no browser geometry");
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 8, sourceBox.y + sourceBox.height / 2, { steps: 3 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
  const markerHandle = await page.waitForFunction((selector) => {
    const node = document.querySelector(selector);
    return node?.closest("[data-reorder-placement]")?.getAttribute("data-reorder-placement") ?? false;
  }, { timeout: 2_000 }, targetSelector).catch(() => null);
  const marker = markerHandle ? await markerHandle.jsonValue() : null;
  await page.mouse.up();
  return marker === "before" || marker === "after";
}

async function selectedTimelineScenes(page: Page): Promise<string[]> {
  return page.$$eval('[data-timeline-scene-id][aria-pressed="true"]', (elements) =>
    elements.map((element) => (element as HTMLElement).dataset.timelineSceneId ?? "").filter(Boolean));
}

async function modifierClick(page: Page, selector: string, modifier?: "Shift" | "Control"): Promise<void> {
  if (modifier) await page.keyboard.down(modifier);
  await page.click(selector);
  if (modifier) await page.keyboard.up(modifier);
}

async function marqueeScenes(page: Page, sceneIds: [string, string]): Promise<void> {
  const surface = await page.waitForSelector("[data-timeline-marquee-surface]");
  const first = await page.waitForSelector(`[data-timeline-scene-id="${sceneIds[0]}"]`);
  const second = await page.waitForSelector(`[data-timeline-scene-id="${sceneIds[1]}"]`);
  const surfaceBox = await surface?.boundingBox();
  const firstBox = await first?.boundingBox();
  const secondBox = await second?.boundingBox();
  if (!surfaceBox || !firstBox || !secondBox) throw new Error("marquee targets have no browser geometry");
  const startX = Math.min(surfaceBox.x + surfaceBox.width - 4, Math.max(firstBox.x + firstBox.width, secondBox.x + secondBox.width) + 24);
  const startY = Math.min(firstBox.y, secondBox.y) + 2;
  const endX = Math.min(firstBox.x, secondBox.x) + 2;
  const endY = Math.max(firstBox.y + firstBox.height, secondBox.y + secondBox.height) - 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();
}

async function waitForEmptyHistory(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const undo = document.querySelector('button[aria-label="Undo"]');
    const redo = document.querySelector('button[aria-label="Redo"]');
    return undo instanceof HTMLButtonElement && undo.disabled
      && redo instanceof HTMLButtonElement && redo.disabled;
  });
}

async function waitForBlockedHistory(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.textContent?.includes("Source changed outside this studio.") === true);
  await page.waitForFunction(() => ["Reload source", "Keep current"].every((label) =>
    [...document.querySelectorAll("button")].some((button) => button.textContent?.includes(label))));
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
 * The harness that verifies the rest of Phase G.
 *
 * Cookie `SameSite` and SSE behaviour are enforced by a real browser and by
 * nothing else — spike S9 measured `curl` answering differently — so these
 * cases cannot be moved to node. What can be checked everywhere is that the
 * harness itself is honest about whether it ran.
 */
describe("browser session harness", () => {
  it("reports a runnable browser or says why not", async () => {
    const availability = await browserAvailability();

    if (availability.available) {
      expect(availability.chromePath).toBeDefined();
      // Executed, not merely found: a truncated download leaves a file that
      // cannot launch, and S9 showed the download tool reporting success for it.
      expect(availability.version?.length).toBeGreaterThan(0);
      return;
    }
    expect(availability.reason).toContain("chrome-headless-shell");
  });

  it("treats a missing browser as fatal only where it was installed", () => {
    // Keyed on its own flag, not on CI: no job installs the browser yet, and a
    // gate that fails for a missing tool rather than a missing behaviour is a
    // gate people learn to ignore. Nobody should download 200 MB to run the
    // unit suite either.
    const flag = process.env.VIDCOM_REQUIRE_BROWSER;
    expect(browserIsRequired()).toBe(flag === "true" || flag === "1");
  });

  it("never skips silently", async () => {
    if (browserIsRequired()) {
      // In CI a missing browser must raise rather than return a skip.
      await expect(requireBrowser()).resolves.toMatchObject({ run: true });
      return;
    }
    const outcome = await requireBrowser();
    if (outcome.run) {
      expect(outcome.chromePath.length).toBeGreaterThan(0);
      return;
    }
    // A skip always carries its reason to stdout.
    expect(outcome.message).toContain("skipped");
    process.stdout.write(`${outcome.message}\n`);
  });

  it("keeps optional browser work out of the generic CI matrix", async () => {
    const priorCi = process.env.CI;
    const priorRequired = process.env.VIDCOM_REQUIRE_BROWSER;
    try {
      process.env.CI = "true";
      delete process.env.VIDCOM_REQUIRE_BROWSER;
      await expect(requireBrowser()).resolves.toEqual({
        run: false,
        message: "browser session tests skipped: dedicated browser-session CI owns required coverage",
      });
    } finally {
      if (priorCi === undefined) delete process.env.CI;
      else process.env.CI = priorCi;
      if (priorRequired === undefined) delete process.env.VIDCOM_REQUIRE_BROWSER;
      else process.env.VIDCOM_REQUIRE_BROWSER = priorRequired;
    }
  });

  it("drives nonce cleanup, picker, and both New video outcomes through the static bundle", async () => {
    const available = await requireBrowser();
    if (!available.run) {
      process.stdout.write(`${available.message}\n`);
      return;
    }
    const root = await mkdtemp(path.join(tmpdir(), "vidcom-browser-ui-"));
    const workspace = path.join(root, "workspace");
    const appData = path.join(root, "app-data");
    await mkdir(workspace);
    const prior = {
      appData: process.env.VIDCOM_APP_DATA,
      workspace: process.env.VIDCOM_WORKSPACE,
      nonce: process.env.VIDCOM_BOOTSTRAP_NONCE,
      settings: process.env.VIDCOM_SETTINGS,
    };
    const nonce = Buffer.alloc(32, 13).toString("base64url");
    process.env.VIDCOM_APP_DATA = appData;
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
      // The hosted runtime resolves its media binaries from the environment, so
      // the drop below probes with a real ffprobe rather than a missing one.
      const ffprobePath = await mediaBinaryPath("ffprobe");
      const ffmpegPath = await mediaBinaryPath("ffmpeg");
      if (ffprobePath) process.env.HYPERFRAMES_FFPROBE_PATH = ffprobePath;
      if (ffmpegPath) process.env.HYPERFRAMES_FFMPEG_PATH = ffmpegPath;
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
      const attachments: Array<{ page: string; projectId: string; studioId: string }> = [];
      const captureStudio = (current: Page, name: string) => current.on("request", (request) => {
        if (request.method() !== "POST") return;
        const match = /^\/api\/v1\/projects\/([^/]+)\/history\/session$/u.exec(new URL(request.url()).pathname);
        const studioId = request.headers()["x-vidcom-studio-session"];
        if (match?.[1] && studioId) attachments.push({ page: name, projectId: match[1], studioId });
      });
      captureStudio(page, "a");
      await page.goto(`${baseUrl}/?t=${encodeURIComponent(nonce)}`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.body.textContent?.includes("Projects") === true);
      expect(new URL(page.url()).searchParams.has("t")).toBe(false);

      await clickText(page, "button", "New video");
      await page.locator('[role="dialog"] input').fill("Browser Video");
      await clickText(page, '[role="dialog"] button', "Create video");
      await page.waitForFunction(() => location.pathname === "/projects/browser-video");
      const created = (await runtime.foundation.application.scanWorkspace())
        .find((entry) => entry.kind === "project" && entry.slug === "browser-video");
      if (!created || created.kind !== "project" || !created.projectId) {
        throw new Error("browser-created project was not discoverable by immutable id");
      }
      const emptySnapshot = await getStudioSnapshot(
        runtime.foundation.application.readDependencies,
        created.projectId,
      );
      if (!emptySnapshot.ok) throw new Error(`browser snapshot failed: ${JSON.stringify(emptySnapshot.error)}`);
      const sceneIds: string[] = [];
      let seedSnapshot = emptySnapshot.value;
      for (const title of ["Browser one", "Browser two", "Browser three", "Browser four", "Browser other track"]) {
        const seeded = await createScene(runtime.foundation.application.writeDependencies, {
          projectId: created.projectId,
          title,
          duration: 4,
          expectedContentHash: seedSnapshot.fileHashes[seedSnapshot.entryFile.path] ?? null,
        }, "system");
        if (!seeded.ok) throw new Error(`browser scene seed failed: ${JSON.stringify(seeded.error)}`);
        sceneIds.push(seeded.value.scene.id);
        const refreshed = await getStudioSnapshot(runtime.foundation.application.readDependencies, created.projectId);
        if (!refreshed.ok) throw new Error(`browser seed refresh failed: ${JSON.stringify(refreshed.error)}`);
        seedSnapshot = refreshed.value;
      }
      const movedTrack = await setSceneTiming(runtime.foundation.application.writeDependencies, {
        projectId: created.projectId,
        sceneId: sceneIds[4]!,
        timing: { start: 1, trackIndex: 2 },
        expectedContentHash: seedSnapshot.fileHashes[seedSnapshot.entryFile.path]!,
      }, "system");
      if (!movedTrack.ok) throw new Error(`browser track seed failed: ${JSON.stringify(movedTrack.error)}`);

      // One real source write proves the server-owned label reaches the rendered
      // timeline, then a second tab proves its stack and ULID are independent.
      // The create-card's slug redirect has its own pre-existing regression;
      // project cards and the studio API use the immutable id, so this focused
      // history harness follows that canonical route after preserving the redirect assertion.
      await page.goto(`${baseUrl}/projects/${encodeURIComponent(created.projectId)}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-timeline-scene-id]');

      const orderWrites: Array<Record<string, unknown>> = [];
      page.on("request", (request) => {
        if (request.method() !== "PATCH" || !new URL(request.url()).pathname.endsWith("/scenes/order")) return;
        if (request.postData()) orderWrites.push(JSON.parse(request.postData()!) as Record<string, unknown>);
      });
      await clickText(page, "button", "Video Scene");
      await page.waitForSelector(`[data-storyboard-scene-id="${sceneIds[0]}"]`);

      const storyboardOrder = page.waitForResponse((response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith("/scenes/order"),
      { timeout: 10_000 }).catch((cause) => { throw new Error("storyboard reorder response timed out", { cause }); });
      expect(await dragReorderHandle(
        page,
        `[data-storyboard-scene-id="${sceneIds[0]}"]`,
        `[data-storyboard-scene-id="${sceneIds[2]}"]`,
      )).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(orderWrites, "storyboard drop must emit one reorder request").toHaveLength(1);
      expect((await storyboardOrder).ok()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const keyboardButton = `[data-storyboard-scene-id="${sceneIds[0]}"] button`;
      await page.focus(keyboardButton);
      expect(await page.$eval(keyboardButton, (node) => document.activeElement === node)).toBe(true);
      const beforeKeyboard = orderWrites.length;
      const keyboardOrder = page.waitForResponse((response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith("/scenes/order"),
      { timeout: 10_000 }).catch((cause) => { throw new Error("keyboard reorder response timed out", { cause }); });
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Alt");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(orderWrites, "Alt+ArrowRight must emit one reorder request").toHaveLength(beforeKeyboard + 1);
      expect((await keyboardOrder).ok()).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page.waitForFunction((sceneId) => document.activeElement?.closest(`[data-storyboard-scene-id="${sceneId}"]`) !== null, {}, sceneIds[0]);
      await page.waitForFunction((sceneId) => document.body.textContent?.includes(`Moved ${sceneId} to position`) === true, {}, sceneIds[0]);
      const beforeBoundary = orderWrites.length;
      await page.focus(`[data-storyboard-scene-id="${sceneIds[4]}"] button`);
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Alt");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(orderWrites).toHaveLength(beforeBoundary);

      const timelineOrder = page.waitForResponse((response) =>
        response.request().method() === "PATCH" && new URL(response.url()).pathname.endsWith("/scenes/order"),
      { timeout: 10_000 }).catch((cause) => { throw new Error("timeline reorder response timed out", { cause }); });
      expect(await dragReorderHandle(
        page,
        `[data-timeline-reorder-id="${sceneIds[1]}"]`,
        `[data-timeline-reorder-id="${sceneIds[2]}"]`,
      )).toBe(true);
      expect((await timelineOrder).ok()).toBe(true);
      expect(orderWrites).toHaveLength(beforeBoundary + 1);

      await modifierClick(page, `[data-timeline-scene-id="${sceneIds[1]}"]`);
      await modifierClick(page, `[data-timeline-scene-id="${sceneIds[2]}"]`, "Shift");
      expect(new Set(await selectedTimelineScenes(page))).toEqual(new Set([sceneIds[1], sceneIds[2]]));
      await modifierClick(page, `[data-timeline-scene-id="${sceneIds[2]}"]`, "Control");
      expect(await selectedTimelineScenes(page)).toEqual([sceneIds[1]]);
      await modifierClick(page, `[data-timeline-scene-id="${sceneIds[4]}"]`, "Shift");
      expect(await selectedTimelineScenes(page)).toEqual([sceneIds[4]]);

      await page.keyboard.press("Escape");
      const sameTrackByDom = await page.$$eval('[data-timeline-scene-id]', (elements, otherTrack) =>
        elements.map((element) => (element as HTMLElement).dataset.timelineSceneId ?? "")
          .filter((sceneId) => sceneId && sceneId !== otherTrack).slice(0, 2), sceneIds[4]);
      expect(sameTrackByDom).toHaveLength(2);
      await marqueeScenes(page, sameTrackByDom as [string, string]);
      const marqueeSelection = await selectedTimelineScenes(page);
      expect(marqueeSelection.length).toBeGreaterThanOrEqual(2);
      expect(marqueeSelection).toEqual(expect.arrayContaining(sameTrackByDom));

      const snapToggle = 'button[aria-label="Toggle timeline snap"]';
      expect(await page.$eval(snapToggle, (button) => button.getAttribute("aria-pressed"))).toBe("true");
      await page.click(snapToggle);
      await page.waitForFunction((selector) =>
        document.querySelector(selector)?.getAttribute("aria-pressed") === "false", {}, snapToggle);

      const moveBodies: Array<Record<string, unknown>> = [];
      page.on("request", (request) => {
        if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/scenes/move")) return;
        if (request.postData()) moveBodies.push(JSON.parse(request.postData()!) as Record<string, unknown>);
      });
      const moveResponse = page.waitForResponse((response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/scenes/move"),
      { timeout: 10_000 }).catch((cause) => { throw new Error("group move response timed out", { cause }); });
      await dragTimelineClip(page, "body", "drop", marqueeSelection[0]);
      expect((await moveResponse).ok()).toBe(true);
      expect(moveBodies).toHaveLength(1);
      expect(new Set(moveBodies[0]?.sceneIds as string[])).toEqual(new Set(marqueeSelection));
      expect(moveBodies[0]).not.toHaveProperty("ripple");

      const deletionBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() !== "POST" || !pathname.includes("/scenes/deletions")) return;
        deletionBodies.push({ path: pathname, body: JSON.parse(request.postData() ?? "{}") as Record<string, unknown> });
      });
      const prepareDeletion = page.waitForResponse((response) =>
        response.request().method() === "POST" && /\/scenes\/deletions$/u.test(new URL(response.url()).pathname),
      { timeout: 10_000 }).catch((cause) => { throw new Error("delete prepare response timed out", { cause }); });
      await clickText(page, "button", "Delete");
      expect((await prepareDeletion).ok()).toBe(true);
      await page.waitForFunction(() => document.body.textContent?.includes("selected scenes") === true);
      const executeDeletion = page.waitForResponse((response) =>
        response.request().method() === "POST" && /\/scenes\/deletions\/[^/]+$/u.test(new URL(response.url()).pathname),
      { timeout: 10_000 }).catch((cause) => { throw new Error("delete execute response timed out", { cause }); });
      await clickText(page, "button", "Confirm delete");
      expect((await executeDeletion).ok()).toBe(true);
      expect(deletionBodies).toHaveLength(2);
      expect(deletionBodies[1]?.body).toEqual(deletionBodies[0]?.body);
      await page.waitForFunction((deleted) => deleted.every((sceneId) =>
        document.querySelector(`[data-timeline-scene-id="${sceneId}"]`) === null), {}, marqueeSelection);

      await clickText(page, "button", "Snap");
      const timingWrites: Array<{ timing?: Record<string, number> }> = [];
      page.on("request", (request) => {
        if (request.method() !== "PATCH") return;
        const pathname = new URL(request.url()).pathname;
        if (!/^\/api\/v1\/projects\/[^/]+\/scenes\/[^/]+$/u.test(pathname)) return;
        const body = request.postData();
        if (body) timingWrites.push(JSON.parse(body) as { timing?: Record<string, number> });
      });

      const bodyRequest = page.waitForRequest((request) =>
        request.method() === "PATCH"
        && /^\/api\/v1\/projects\/[^/]+\/scenes\/[^/]+$/u.test(new URL(request.url()).pathname),
      { timeout: 10_000 });
      const bodyResponse = page.waitForResponse((response) =>
        response.request().method() === "PATCH"
        && /^\/api\/v1\/projects\/[^/]+\/scenes\/[^/]+$/u.test(new URL(response.url()).pathname),
      { timeout: 10_000 });
      await dragTimelineClip(page, "body", "drop");
      await Promise.all([bodyRequest, bodyResponse]);
      expect(timingWrites).toHaveLength(1);
      expect(timingWrites[0]).toMatchObject({ timing: { start: expect.any(Number) } });

      const edgeRequest = page.waitForRequest((request) =>
        request.method() === "PATCH"
        && /^\/api\/v1\/projects\/[^/]+\/scenes\/[^/]+$/u.test(new URL(request.url()).pathname),
      { timeout: 10_000 });
      const edgeResponse = page.waitForResponse((response) =>
        response.request().method() === "PATCH"
        && /^\/api\/v1\/projects\/[^/]+\/scenes\/[^/]+$/u.test(new URL(response.url()).pathname),
      { timeout: 10_000 });
      await dragTimelineClip(page, "trim-end", "drop");
      await Promise.all([edgeRequest, edgeResponse]);
      expect(timingWrites).toHaveLength(2);
      expect(timingWrites[1]).toMatchObject({ timing: { duration: expect.any(Number) } });

      await dragTimelineClip(page, "body", "escape");
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(timingWrites).toHaveLength(2);

      // One drop, one operation: the upload and the mount that follows it share
      // an operation id, and the clip they produce is the one that ends up
      // selected. Needs a real ffprobe, because the mount duration is probed.
      const probe = await mediaBinaryPath("ffprobe");
      if (probe === null) {
        process.stdout.write("SKIPPING timeline drop: ffprobe is not installed\n");
      } else {
        const assetRequests: Array<{ pathname: string; search: string; body: string | undefined }> = [];
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (request.method() !== "POST") return;
          if (!/\/assets(\/mount)?$/u.test(url.pathname)) return;
          assetRequests.push({ pathname: url.pathname, search: url.search, body: request.postData() });
        });
        const mountResponse = page.waitForResponse((response) =>
          response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/assets/mount"),
        { timeout: 20_000 }).catch((cause) => { throw new Error("timeline drop mount timed out", { cause }); });
        await page.evaluate((bytes) => {
          const surface = document.querySelector("[data-timeline-marquee-surface]");
          if (!surface) throw new Error("timeline drop surface is missing");
          const transfer = new DataTransfer();
          transfer.items.add(new File([new Uint8Array(bytes)], "dropped.png", { type: "image/png" }));
          const bounds = surface.getBoundingClientRect();
          const init: DragEventInit = {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + Math.min(120, bounds.width / 2),
            clientY: bounds.top + 20,
            dataTransfer: transfer,
          };
          surface.dispatchEvent(new DragEvent("dragover", init));
          surface.dispatchEvent(new DragEvent("drop", init));
        }, [...DROPPED_PNG]);
        const mounted = await mountResponse;
        expect(mounted.ok()).toBe(true);
        const payload = await mounted.json() as { sceneId: string; replayed: boolean };
        expect(payload.replayed).toBe(false);

        const uploads = assetRequests.filter((request) => request.pathname.endsWith("/assets"));
        const mounts = assetRequests.filter((request) => request.pathname.endsWith("/assets/mount"));
        expect(uploads).toHaveLength(1);
        expect(mounts).toHaveLength(1);
        const operationId = new URLSearchParams(uploads[0]!.search).get("operationId");
        expect(operationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
        // The mount carries the operation and the precondition, and no placement:
        // where the clip goes is the server's record, not this request.
        expect(JSON.parse(mounts[0]!.body ?? "{}")).toEqual({
          operationId,
          expectedContentHash: expect.any(String),
          onOverflow: "extend-root",
        });
        await page.waitForFunction((sceneId) =>
          document.querySelector(`[data-timeline-scene-id="${sceneId}"]`)?.getAttribute("aria-pressed") === "true",
        { timeout: 10_000 }, payload.sceneId);
      }

      // Timing writes belong to the first ephemeral studio session. Reloading
      // keeps the source changes while giving the history assertions below a
      // clean independent baseline.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForEmptyHistory(page);
      await appendSourceAndSave(page, "history-a-1");
      const projectUrl = page.url();
      const pageB = await browser.newPage();
      captureStudio(pageB, "b");
      await pageB.goto(projectUrl, { waitUntil: "domcontentloaded" });
      await waitForEmptyHistory(pageB);
      await appendSourceAndSave(pageB, "history-b-1");
      await waitForBlockedHistory(page);

      const firstA = attachments.find((entry) => entry.page === "a");
      const firstB = attachments.find((entry) => entry.page === "b");
      expect(firstA?.projectId).toBe(firstB?.projectId);
      expect(firstA?.studioId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
      expect(firstB?.studioId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
      expect(firstA?.studioId).not.toBe(firstB?.studioId);

      // Both visible escape paths are actionable. Keep current clears only the
      // history; a page reload then gets a fresh ephemeral ULID and cannot
      // reconstruct the previous stack.
      await clickText(page, "button", "Keep current");
      await waitForEmptyHistory(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForEmptyHistory(page);
      const aIdsAfterReload = attachments.filter((entry) => entry.page === "a").map((entry) => entry.studioId);
      expect(new Set(aIdsAfterReload).size).toBeGreaterThanOrEqual(2);
      expect(aIdsAfterReload.at(-1)).not.toBe(firstA?.studioId);

      // A fresh conflict exercises Reload source as well: after it clears the
      // stack, the editor is remounted from the other tab's committed bytes.
      await appendSourceAndSave(page, "history-a-2");
      await pageB.reload({ waitUntil: "domcontentloaded" });
      await waitForEmptyHistory(pageB);
      await appendSourceAndSave(pageB, "history-b-2");
      await waitForBlockedHistory(page);
      await clickText(page, "button", "Reload source");
      await waitForEmptyHistory(page);
      await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("history-b-2") === true);

      // R8: a draft survives a change made outside it, and none of the three
      // exits drops one silently.
      const typed = await page.$eval(".cm-content", (element) => element.textContent ?? "");
      await page.locator(".cm-content").fill(`${typed}\n<!-- draft-a -->`);
      await page.waitForFunction(() => document.body.innerText.includes("Unsaved changes"));

      // Space inside the editor types a space; it does not reach the transport.
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("draft-a") === true);

      await appendSourceAndSave(pageB, "outside-1");
      await page.waitForFunction(() => document.body.innerText.includes("This file changed outside the editor"));
      expect(await page.$$eval("button", (buttons) => buttons
        .filter((button) => button.textContent?.includes("Save"))
        .every((button) => (button as HTMLButtonElement).disabled))).toBe(true);

      // Compare shows the other version beside the draft without deciding anything.
      await clickText(page, "button", "Compare");
      await page.waitForSelector('[aria-label="Version from outside the editor"]');
      expect(await page.$eval('[aria-label="Version from outside the editor"]', (element) =>
        element.textContent?.includes("outside-1") === true)).toBe(true);

      // Keeping the draft rebases it, so the save that follows lands rather than 409s.
      await clickText(page, "button", "Keep mine");
      await page.waitForFunction(() => [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.includes("Save") && !(button as HTMLButtonElement).disabled));
      const keptSave = page.waitForResponse((response) =>
        response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/files"),
      { timeout: 10_000 });
      await clickText(page, "button", "Save");
      expect((await keptSave).ok()).toBe(true);
      await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("draft-a") === true);

      // Closing a tab that still has a draft asks before dropping it.
      await page.evaluate(() => {
        const asked: string[] = [];
        (window as unknown as { asked: string[] }).asked = asked;
        window.confirm = (message?: string) => { asked.push(message ?? ""); return false; };
      });
      const stillTyped = await page.$eval(".cm-content", (element) => element.textContent ?? "");
      await page.locator(".cm-content").fill(`${stillTyped}\n<!-- draft-b -->`);
      await page.waitForFunction(() => document.body.innerText.includes("Unsaved changes"));
      await page.click('button[aria-label^="Close index.html"]');
      expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked.length)).toBe(1);
      // Refused, so the tab and the draft are both still there.
      expect(await page.$eval(".cm-content", (element) => element.textContent?.includes("draft-b") === true)).toBe(true);

      // Leaving the project asks with the same question.
      await page.click('a[href="/"]');
      expect(await page.evaluate(() => (window as unknown as { asked: string[] }).asked.length)).toBe(2);
      // Answering yes lets the same exits through, which is what the rest of
      // this scenario needs.
      await page.evaluate(() => { window.confirm = () => true; });
      await page.click('button[aria-label^="Close index.html"]');
      await page.waitForFunction(() => !document.body.innerText.includes("Unsaved changes"));

      // A different authenticated browser context cannot steal tab A's studio
      // id; the same id is also rejected when paired with another project.
      const secondNonce = Buffer.alloc(32, 23).toString("base64url");
      runtime.nonces.register(secondNonce);
      const isolated = await browser.createBrowserContext();
      const pageC = await isolated.newPage();
      await pageC.goto(`${projectUrl}?t=${encodeURIComponent(secondNonce)}`, { waitUntil: "domcontentloaded" });
      await waitForEmptyHistory(pageC);
      const stolenStatus = await pageC.evaluate(async ({ projectId, studioId }) => {
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/history/session`, {
          method: "POST",
          headers: { "x-vidcom-studio-session": studioId },
        });
        return response.status;
      }, { projectId: firstA!.projectId, studioId: aIdsAfterReload.at(-1)! });
      expect(stolenStatus).toBe(400);
      const wrongProjectStatus = await page.evaluate(async (studioId) => {
        const response = await fetch("/api/v1/projects/project_other/history", {
          headers: { "x-vidcom-studio-session": studioId },
        });
        return response.status;
      }, aIdsAfterReload.at(-1)!);
      expect(wrongProjectStatus).toBe(400);
      await isolated.close();

      await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
      await clickText(page, "button", "New video");
      await page.locator('[role="dialog"] input').fill("Browser Video");
      await clickText(page, '[role="dialog"] button', "Create video");
      await page.waitForSelector('[role="alert"]');
      expect(await page.locator('[role="alert"]').map((element) => element.textContent).wait())
        .toMatch(/exists|available|failed|create/iu);

      let activationObserved = false;
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/v1/system/workspace") {
          void request.respond({ status: 200, contentType: "application/json", body: '{"workspaceRoot":null}' });
        } else if (pathname === "/api/v1/system/filesystem/roots") {
          void request.respond({
            status: 200,
            contentType: "application/json",
            body: '{"roots":[{"displayPath":"Fixture","token":"root-token"}]}',
          });
        } else if (pathname === "/api/v1/system/filesystem/entries") {
          void request.respond({
            status: 200,
            contentType: "application/json",
            body: '{"displayPath":"Fixture","entries":[{"name":"Chosen","isDirectory":true,"token":"chosen-token"}]}',
          });
        } else if (pathname === "/api/v1/workspace/active") {
          activationObserved = true;
          void request.respond({
            status: 200,
            contentType: "application/json",
            body: '{"workspaceRoot":"Fixture/Chosen","reauthRequired":true}',
          });
        } else {
          void request.continue();
        }
      });
      await page.goto(`${baseUrl}/`, { waitUntil: "networkidle0" });
      await page.waitForSelector('[aria-label="Choose a workspace folder"]');
      await clickText(page, "button", "Fixture");
      await page.waitForFunction(() => document.body.textContent?.includes("Chosen") === true);
      await clickText(page, "button", "Chosen");
      await page.waitForFunction(() => document.body.textContent?.includes("Use this folder") === true);
      await clickText(page, "button", "Use this folder");
      await page.waitForFunction(() => document.readyState === "complete");
      expect(activationObserved).toBe(true);
    } finally {
      await browser?.close();
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await runtime?.foundation.stop();
      if (prior.appData === undefined) delete process.env.VIDCOM_APP_DATA;
      else process.env.VIDCOM_APP_DATA = prior.appData;
      if (prior.workspace === undefined) delete process.env.VIDCOM_WORKSPACE;
      else process.env.VIDCOM_WORKSPACE = prior.workspace;
      if (prior.nonce === undefined) delete process.env.VIDCOM_BOOTSTRAP_NONCE;
      else process.env.VIDCOM_BOOTSTRAP_NONCE = prior.nonce;
      if (prior.settings === undefined) delete process.env.VIDCOM_SETTINGS;
      else process.env.VIDCOM_SETTINGS = prior.settings;
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
