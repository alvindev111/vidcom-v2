// @vitest-environment node

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { HTTPRequest, Page } from "puppeteer-core";
import { describe, expect, it } from "vitest";

import { ErrorCode, representativeSceneTime, type ProjectId, type RelPath } from "@vidcom/contracts";
import { createScene, getStudioSnapshot } from "@vidcom/core";

import { withStudioBrowser } from "../support/browser-studio";

/**
 * The editing experience, measured in a real browser.
 *
 * R4.1c is a budget on what a person waits for, so it is measured end to end
 * here rather than inferred from a spike: from the moment the change is known —
 * a write's own success response, or the durable event that announces someone
 * else's — to the moment the visible preview frame is showing it.
 */

const BUDGET_MS = 500;

interface Probe {
  previewAt(seq: number): number | null;
  latestEvent(): { seq: number; at: number } | null;
}

function probe(page: Page) {
  return {
    previewAt: (seq: number) => page.evaluate((target: number) =>
      (window as unknown as { probe: Probe }).probe.previewAt(target), seq),
    latestEvent: () => page.evaluate(() =>
      (window as unknown as { probe: Probe }).probe.latestEvent()),
  };
}

/** Records when the visible preview and the event stream reach each sequence. */
async function install(page: Page): Promise<void> {
  await page.evaluate(() => {
    const previews = new Map<number, number>();
    let latest: { seq: number; at: number } | null = null;
    const scan = () => {
      const element = document.querySelector("[data-preview-change-seq]") as HTMLElement | null;
      const preview = Number(element?.dataset.previewChangeSeq);
      if (Number.isFinite(preview) && !previews.has(preview)) previews.set(preview, performance.now());
      const event = Number(document.documentElement.dataset.studioEventSeq);
      if (Number.isFinite(event) && (latest === null || event > latest.seq)) {
        latest = { seq: event, at: performance.now() };
      }
    };
    new MutationObserver(scan).observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-preview-change-seq", "data-studio-event-seq"],
    });
    scan();
    (window as unknown as { probe: Probe }).probe = {
      previewAt(seq) {
        for (const [seen, at] of previews) if (seen >= seq) return at;
        return null;
      },
      latestEvent: () => latest,
    };
  });
}

/** Waits until the visible preview shows `seq`, and reports when it got there. */
async function previewReached(page: Page, seq: number): Promise<number> {
  await page.waitForFunction((target: number) =>
    (window as unknown as { probe: Probe }).probe.previewAt(target) !== null,
  { timeout: 20_000, polling: 16 }, seq);
  return (await probe(page).previewAt(seq))!;
}

/** Opens a lazily loaded source through the real project file explorer. */
async function openTreeSource(page: Page, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    await page.waitForFunction((label) => [...document.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === label), { timeout: 10_000 }, segment);
    const buttons = await page.$$("button");
    for (const button of buttons) {
      if (await button.evaluate((node) => node.textContent?.trim()) !== segment) continue;
      if (await button.evaluate((node) => node.getAttribute("aria-expanded")) !== "true") await button.click();
      break;
    }
  }
  const filename = segments.at(-1);
  if (!filename) throw new Error(`source path has no filename: ${relativePath}`);
  await page.waitForFunction((label) => [...document.querySelectorAll("button")]
    .some((button) => button.textContent?.trim() === label), { timeout: 10_000 }, filename);
  const buttons = await page.$$("button");
  for (const button of buttons) {
    if (await button.evaluate((node) => node.textContent?.trim()) !== filename) continue;
    await button.click();
    break;
  }
  await page.waitForFunction((label) => [...document.querySelectorAll("button")]
    .some((button) => button.getAttribute("aria-label")?.startsWith(`Close ${label}`)),
  { timeout: 10_000 }, filename);
  await page.waitForFunction((path) => [...document.querySelectorAll("[data-active] button[title]")]
    .some((button) => button.getAttribute("title") === path),
  { timeout: 10_000 }, relativePath);
}

/** Selects a tree entry for rename/delete without requiring it to open in the editor. */
async function selectTreeEntry(page: Page, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  for (const [index] of segments.slice(0, -1).entries()) {
    const folderPath = segments.slice(0, index + 1).join("/");
    await page.waitForFunction((path) => [...document.querySelectorAll("button[data-file-path]")]
      .some((button) => button.getAttribute("data-file-path") === path), { timeout: 10_000 }, folderPath);
    await page.evaluate((path) => {
      const button = [...document.querySelectorAll("button[data-file-path]")]
        .find((candidate) => candidate.getAttribute("data-file-path") === path) as HTMLButtonElement | undefined;
      if (button?.getAttribute("aria-expanded") !== "true") button?.click();
    }, folderPath);
  }
  if (!segments.at(-1)) throw new Error(`managed path has no filename: ${relativePath}`);
  await page.waitForFunction((path) => [...document.querySelectorAll("button[data-file-path]")]
    .some((button) => button.getAttribute("data-file-path") === path), { timeout: 10_000 }, relativePath);
  await page.evaluate((path) => {
    const button = [...document.querySelectorAll("button[data-file-path]")]
      .find((candidate) => candidate.getAttribute("data-file-path") === path) as HTMLButtonElement | undefined;
    button?.click();
  }, relativePath);
  await page.waitForFunction(() => {
    const rename = document.querySelector('button[aria-label="Rename selected entry"]') as HTMLButtonElement | null;
    return rename !== null && !rename.disabled;
  }, { timeout: 10_000 });
}

async function clickExactButton(page: Page, label: string): Promise<void> {
  await page.waitForFunction((exactLabel) => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === exactLabel) as HTMLButtonElement | undefined;
    if (!button) return false;
    button.click();
    return true;
  }, { timeout: 10_000, polling: 16 }, label);
}

describe("editing experience in a browser", () => {
  it("auto-loads storyboard thumbnails, retries typed failures, and preserves scene identity", async () => {
    await withStudioBrowser("storyboard-thumbnails", async ({ page, projectId, runtime }) => {
      const before = await getStudioSnapshot(runtime.foundation.application.readDependencies, projectId as ProjectId);
      if (!before.ok) throw new Error(`storyboard seed snapshot failed: ${JSON.stringify(before.error)}`);
      const created = await createScene(runtime.foundation.application.writeDependencies, {
        projectId: projectId as ProjectId,
        title: "Second beat",
        duration: 4,
        expectedContentHash: before.value.fileHashes[before.value.entryFile.path] ?? null,
      }, "system");
      if (!created.ok) throw new Error(`storyboard scene seed failed: ${JSON.stringify(created.error)}`);
      const seeded = await getStudioSnapshot(runtime.foundation.application.readDependencies, projectId as ProjectId);
      if (!seeded.ok || seeded.value.scenes.length < 2) {
        throw new Error(`storyboard seed did not produce two scenes: ${JSON.stringify(seeded)}`);
      }
      const sceneIds = seeded.value.scenes.slice(0, 2).map((scene) => scene.id);
      const failedSceneId = sceneIds[1]!;
      const attempts = new Map<string, number>();
      const requests: Array<{ sceneId: string; atSeconds: number[]; profile: string }> = [];
      let markRevalidationStarted!: () => void;
      const revalidationStarted = new Promise<void>((resolve) => { markRevalidationStarted = resolve; });
      let releaseRevalidation!: () => void;
      const revalidationRelease = new Promise<void>((resolve) => { releaseRevalidation = resolve; });
      let heldRevalidation = false;

      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = new URL(request.url());
        const thumbnails = `/api/v1/projects/${encodeURIComponent(projectId)}/thumbnails`;
        if (request.method() === "POST" && url.pathname === thumbnails) {
          const payload = JSON.parse(request.postData() ?? "{}") as {
            sceneId: string; atSeconds: number[]; profile: string;
          };
          const scene = seeded.value.scenes.find((candidate) => candidate.id === payload.sceneId)!;
          const representative = representativeSceneTime(scene.duration, seeded.value.frameRate);
          const storyboardRequest = payload.atSeconds.length === 1 && payload.atSeconds[0] === representative;
          const count = storyboardRequest ? (attempts.get(payload.sceneId) ?? 0) + 1 : 0;
          if (storyboardRequest) {
            requests.push(payload);
            attempts.set(payload.sceneId, count);
          }
          const lines = payload.atSeconds.map((atSeconds) =>
            storyboardRequest && payload.sceneId === failedSceneId && count === 1
              ? { atSeconds, status: "placeholder", reason: ErrorCode.NotFound }
              : {
                  atSeconds,
                  status: "ready",
                  url: `${thumbnails}/${payload.sceneId === failedSceneId ? "b".repeat(64) : "a".repeat(64)}`,
                });
          const response = {
            status: 200,
            contentType: "application/x-ndjson; charset=utf-8",
            body: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
          };
          if (payload.sceneId === failedSceneId && count >= 3 && !heldRevalidation) {
            heldRevalidation = true;
            markRevalidationStarted();
            void revalidationRelease.then(() => request.respond(response));
          } else void request.respond(response);
          return;
        }
        if (request.method() === "GET" && /^\/api\/v1\/projects\/[^/]+\/thumbnails\/[a-f0-9]{64}$/u.test(url.pathname)) {
          void request.respond({
            status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#0f766e"/><circle cx="80" cy="45" r="24" fill="#fbbf24"/></svg>',
          });
          return;
        }
        void request.continue();
      });

      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForSelector("[data-timeline-viewport]", { timeout: 30_000 });
      const videoSceneTab = (await Promise.all((await page.$$('[role="tab"]')).map(async (tab) => ({
        tab,
        text: await tab.evaluate((node) => node.textContent?.trim()),
      })))).find(({ text }) => text === "Video Scene")?.tab;
      if (!videoSceneTab) throw new Error("Video Scene tab was not found");
      await videoSceneTab.click();
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      const tabState = await page.evaluate(() => ({
        body: document.body.innerText.slice(0, 800),
        tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
          text: tab.textContent?.trim(),
          state: tab.getAttribute("data-state"),
          selected: tab.getAttribute("aria-selected"),
        })),
      }));
      if (!tabState.body.toLowerCase().includes("storyboard")) {
        throw new Error(`Video Scene tab did not open: ${JSON.stringify(tabState)}`);
      }
      await page.waitForSelector(`[data-storyboard-scene-id="${sceneIds[0]}"]`);
      await page.waitForFunction((ids) => ids.every((id) =>
        document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state]`) !== null),
      { timeout: 15_000 }, sceneIds);
      await page.waitForFunction((id) =>
        document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state="ready"]`) !== null,
      { timeout: 15_000 }, sceneIds[0]);
      try {
        await page.waitForFunction((id) =>
          document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state="failed"]`) !== null,
        { timeout: 15_000 }, failedSceneId);
      } catch (cause) {
        const states = await page.$$eval("[data-storyboard-scene-id]", (cards) => cards.map((card) => ({
          sceneId: card.getAttribute("data-storyboard-scene-id"),
          state: card.querySelector("[data-storyboard-thumbnail-state]")?.getAttribute("data-storyboard-thumbnail-state"),
          text: card.textContent?.trim(),
        })));
        throw new Error(`failed thumbnail did not settle: ${JSON.stringify({ requests, states })}`, { cause });
      }

      expect(requests).toHaveLength(2);
      expect(requests.map(({ sceneId }) => sceneId).sort()).toEqual([...sceneIds].sort());
      expect(requests.every(({ profile, atSeconds }) => profile === "timeline-v1" && atSeconds.length === 1)).toBe(true);
      for (const request of requests) {
        const scene = seeded.value.scenes.find((candidate) => candidate.id === request.sceneId)!;
        expect(request.atSeconds[0]).toBe(representativeSceneTime(scene.duration, seeded.value.frameRate));
      }
      expect(await page.$eval("body", (body) => body.innerText.includes("hyperframes snapshot"))).toBe(false);

      await page.click(`[data-storyboard-scene-id="${sceneIds[0]}"] button`);
      expect(await page.$eval(`[data-storyboard-scene-id="${sceneIds[0]}"]`, (node) => node.hasAttribute("data-selected")))
        .toBe(true);
      await page.click(`[aria-label="Retry thumbnail for ${failedSceneId}"]`);
      await page.waitForFunction((id) =>
        document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state="ready"]`) !== null,
      { timeout: 15_000 }, failedSceneId);
      expect(attempts.get(failedSceneId)).toBe(2);

      const reordered = page.waitForResponse((response) => response.request().method() === "PATCH"
        && new URL(response.url()).pathname.endsWith("/scenes/order"));
      await page.focus(`[data-storyboard-scene-id="${failedSceneId}"] button`);
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.up("Alt");
      expect((await reordered).ok()).toBe(true);
      await page.waitForFunction((id) =>
        document.querySelector("[data-storyboard-scene-id]")?.getAttribute("data-storyboard-scene-id") === id,
      { timeout: 15_000 }, failedSceneId);
      await Promise.race([
        revalidationStarted,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("post-reorder thumbnail revalidation did not start")),
          15_000,
        )),
      ]);
      expect(await page.$eval(
        `[data-storyboard-scene-id="${failedSceneId}"] [data-storyboard-thumbnail-state]`,
        (node) => node.getAttribute("data-storyboard-thumbnail-state"),
      )).toBe("ready");
      releaseRevalidation();
      await page.waitForFunction((id) =>
        document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state="ready"]`) !== null,
      { timeout: 15_000 }, failedSceneId);
      expect(await page.$eval(`[data-storyboard-scene-id="${failedSceneId}"] img`, (image) => image.getAttribute("alt")))
        .toBe(`Thumbnail for ${failedSceneId}`);
    });
  }, 180_000);

  it("bounds 100-scene storyboard work, aborts stale requests, and reuses ready frames", async () => {
    await withStudioBrowser("storyboard-virtualization", async ({ page, projectId, runtime }) => {
      const studioUrl = page.url();
      // Keep the open studio from processing 99 intermediate project-change
      // events while this fixture is being assembled. The behavior under test
      // starts from the completed 100-scene project, not from its seed loop.
      await page.goto("about:blank");
      const initial = await getStudioSnapshot(runtime.foundation.application.readDependencies, projectId as ProjectId);
      if (!initial.ok) throw new Error(`100-scene seed snapshot failed: ${JSON.stringify(initial.error)}`);
      let expectedContentHash = initial.value.fileHashes[initial.value.entryFile.path] ?? null;
      for (let index = initial.value.scenes.length; index < 100; index += 1) {
        const created = await createScene(runtime.foundation.application.writeDependencies, {
          projectId: projectId as ProjectId,
          title: `Beat ${index + 1}`,
          duration: 1,
          expectedContentHash,
        }, "system");
        if (!created.ok) throw new Error(`scene ${index + 1} seed failed: ${JSON.stringify(created.error)}`);
        expectedContentHash = created.value.envelope.fileHashes[initial.value.entryFile.path] ?? null;
      }
      const seeded = await getStudioSnapshot(runtime.foundation.application.readDependencies, projectId as ProjectId);
      if (!seeded.ok || seeded.value.scenes.length !== 100) {
        throw new Error(`100-scene seed failed: ${JSON.stringify(seeded)}`);
      }
      const scenes = new Map(seeded.value.scenes.map((scene) => [scene.id, scene]));
      const requestCounts = new Map<string, number>();
      const active = new Set<HTTPRequest>();
      let maxActive = 0;
      let abortCount = 0;

      let intercepting = false;
      page.on("requestfailed", (request) => {
        if (active.delete(request)) abortCount += 1;
      });
      page.on("request", (request) => {
        if (!intercepting) return;
        const url = new URL(request.url());
        const thumbnails = `/api/v1/projects/${encodeURIComponent(projectId)}/thumbnails`;
        if (request.method() === "POST" && url.pathname === thumbnails) {
          const payload = JSON.parse(request.postData() ?? "{}") as {
            sceneId: string; atSeconds: number[]; profile: string;
          };
          const scene = scenes.get(payload.sceneId);
          const storyboardRequest = scene !== undefined
            && payload.atSeconds.length === 1
            && payload.atSeconds[0] === representativeSceneTime(scene.duration, seeded.value.frameRate);
          if (!storyboardRequest) {
            const lines = payload.atSeconds.map((atSeconds) => ({
              atSeconds,
              status: "ready",
              url: `${thumbnails}/${"c".repeat(64)}`,
            }));
            void request.respond({
              status: 200,
              contentType: "application/x-ndjson; charset=utf-8",
              body: `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
            });
            return;
          }
          requestCounts.set(payload.sceneId, (requestCounts.get(payload.sceneId) ?? 0) + 1);
          active.add(request);
          maxActive = Math.max(maxActive, active.size);
          setTimeout(() => {
            if (!active.delete(request)) return;
            void request.respond({
              status: 200,
              contentType: "application/x-ndjson; charset=utf-8",
              body: `${JSON.stringify({
                atSeconds: payload.atSeconds[0],
                status: "ready",
                url: `${thumbnails}/${"d".repeat(64)}`,
              })}\n`,
            }).catch(() => { abortCount += 1; });
          }, 800);
          return;
        }
        if (request.method() === "GET" && /^\/api\/v1\/projects\/[^/]+\/thumbnails\/[a-f0-9]{64}$/u.test(url.pathname)) {
          void request.respond({
            status: 200,
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#172554"/></svg>',
          });
          return;
        }
        void request.continue();
      });

      // Seeding 100 scenes emits 100 project-change events. Navigate cleanly to
      // the canonical URL so this test cancels any queued reload instead of
      // waiting behind that obsolete preview work.
      await page.goto(studioUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForSelector("[data-timeline-viewport]", { timeout: 30_000 });
      await page.setRequestInterception(true);
      intercepting = true;
      const videoSceneTab = (await Promise.all((await page.$$('[role="tab"]')).map(async (tab) => ({
        tab,
        text: await tab.evaluate((node) => node.textContent?.trim()),
      })))).find(({ text }) => text === "Video Scene")?.tab;
      if (!videoSceneTab) throw new Error("Video Scene tab was not found");
      await videoSceneTab.click();
      await page.waitForFunction(() => document.querySelectorAll("[data-storyboard-scene-id]").length === 100,
        { timeout: 30_000 });

      const firstSceneId = seeded.value.scenes[0]!.id;
      const lastSceneId = seeded.value.scenes.at(-1)!.id;
      await page.waitForFunction((id) =>
        document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state="ready"]`) !== null,
      { timeout: 15_000 }, firstSceneId);
      expect(requestCounts.get(firstSceneId)).toBe(1);
      const topWindowCount = requestCounts.size;
      expect(topWindowCount).toBeGreaterThan(0);
      expect(topWindowCount).toBeLessThan(100);

      await page.$eval(`[data-storyboard-scene-id="${lastSceneId}"]`, (card) => card.scrollIntoView({ block: "end" }));
      await page.waitForFunction((id) =>
        document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state="loading"]`) !== null,
      { timeout: 10_000 }, lastSceneId);
      await page.$eval(`[data-storyboard-scene-id="${firstSceneId}"]`, (card) => card.scrollIntoView({ block: "start" }));
      await page.waitForFunction((id) =>
        document.querySelector(`[data-storyboard-scene-id="${id}"] [data-storyboard-thumbnail-state="ready"]`) !== null,
      { timeout: 10_000 }, firstSceneId);
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));

      expect(requestCounts.get(firstSceneId)).toBe(1);
      expect(requestCounts.has(lastSceneId)).toBe(true);
      expect(requestCounts.size).toBeLessThan(100);
      expect(maxActive).toBeLessThan(100);
      expect(abortCount).toBeGreaterThan(0);
      process.stdout.write(`Storyboard 100 scenes: requested=${requestCounts.size}, maxActive=${maxActive}, aborted=${abortCount}, topWindow=${topWindowCount}\n`);
    });
  }, 240_000);

  it("shows this tab's own write in the preview within the R4.1c budget", async () => {
    await withStudioBrowser("perf-write", async ({ page }) => {
      await install(page);
      // The budget is what a person waits after saving into a studio that is
      // already showing them a preview — so wait for the first frame before
      // starting, or the measurement includes the initial mount.
      await page.waitForFunction(() => [...document.querySelectorAll("[data-player-host-id] iframe")]
        .some((frame) => (frame as HTMLElement).style.opacity === "1"),
      { timeout: 30_000, polling: 50 });
      // The studio's own writes, driven through the studio: the budget is what a
      // person waits after saving, so the clock starts at the response their own
      // save produced, not at a request this test invented.
      await page.evaluate(() => {
        interface Recorded { path: string; at: number; changeSeq: number | null }
        const recorded: Recorded[] = [];
        (window as unknown as { recorded: Recorded[] }).recorded = recorded;
        const original = window.fetch.bind(window);
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await original(input, init);
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
          const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
          const interesting = (method === "PUT" && url.pathname.endsWith("/files"))
            || (method === "PATCH" && url.pathname.endsWith("/preview-settings"));
          if (!interesting) return response;
          const clone = response.clone();
          const payload = await clone.json().catch(() => null) as { changeSeq?: number | null } | null;
          recorded.push({ path: url.pathname, at: performance.now(), changeSeq: payload?.changeSeq ?? null });
          return response;
        };
      });

      const settled = async (path: string) => {
        await page.waitForFunction((suffix: string) =>
          (window as unknown as { recorded: Array<{ path: string }> }).recorded.some((entry) => entry.path.endsWith(suffix)),
        { timeout: 20_000 }, path);
        return await page.evaluate((suffix: string) => {
          const all = (window as unknown as { recorded: Array<{ path: string; at: number; changeSeq: number | null }> }).recorded;
          return all.filter((entry) => entry.path.endsWith(suffix)).at(-1)!;
        }, path);
      };

      // Case 1 — a content mutation saved from the editor.
      const typed = await page.$eval(".cm-content", (element) => element.textContent ?? "");
      await page.locator(".cm-content").fill(`${typed}\n<!-- measured -->`);
      await page.waitForFunction(() => [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.includes("Save") && !(button as HTMLButtonElement).disabled));
      await page.evaluate(() => {
        const save = [...document.querySelectorAll("button")]
          .find((button) => button.textContent?.includes("Save")) as HTMLButtonElement | undefined;
        save?.click();
      });
      const contentWrite = await settled("/files");
      expect(contentWrite.changeSeq).not.toBeNull();
      const contentAt = await previewReached(page, contentWrite.changeSeq!);
      const contentMs = contentAt - contentWrite.at;
      process.stdout.write(`R4.1c browser content mutation: ${contentMs.toFixed(0)} ms\n`);
      expect(contentMs).toBeLessThan(BUDGET_MS);

      // Case 2 — a preview-settings mutation, which rebuilds the preview
      // document without touching the project's scenes.
      // Hiding a scene is a preview-settings write the studio makes on its own,
      // which rebuilds the preview document without touching the project.
      await page.evaluate(() => {
        const toggle = [...document.querySelectorAll("button")]
          .find((button) => (button.getAttribute("aria-label") ?? "").includes("in the preview")) as HTMLButtonElement | undefined;
        toggle?.click();
      });
      const settingsWrite = await settled("/preview-settings");
      expect(settingsWrite.changeSeq).not.toBeNull();
      const settingsMs = await previewReached(page, settingsWrite.changeSeq!) - settingsWrite.at;
      process.stdout.write(`R4.1c browser preview-settings mutation: ${settingsMs.toFixed(0)} ms\n`);
      expect(settingsMs).toBeLessThan(BUDGET_MS);
    });
  }, 180_000);

  it("shows a write made outside the app within the budget of the event that announced it", async () => {
    await withStudioBrowser("perf-outside", async ({ page, projectRoot }) => {
      await install(page);
      await page.waitForFunction(() => [...document.querySelectorAll("[data-player-host-id] iframe")]
        .some((frame) => (frame as HTMLElement).style.opacity === "1"),
      { timeout: 30_000, polling: 50 });

      // Written straight to disk, with no request from this tab: the page can
      // only learn about it from the durable event stream, which is where the
      // clock starts.
      for (const target of ["index.html", "preview-settings.json"] as const) {
        const before = (await probe(page).latestEvent())?.seq ?? 0;
        const file = path.join(projectRoot, target);
        const current = await readFile(file, "utf8");
        await writeFile(file, target === "index.html"
          ? `${current}\n<!-- outside -->`
          : JSON.stringify({ ...JSON.parse(current) as Record<string, unknown>, grid: true }, null, 2));

        await page.waitForFunction((seen: number) => {
          const latest = (window as unknown as { probe: Probe }).probe.latestEvent();
          return latest !== null && latest.seq > seen;
        }, { timeout: 30_000, polling: 16 }, before);
        const announced = (await probe(page).latestEvent())!;
        const elapsed = await previewReached(page, announced.seq) - announced.at;
        process.stdout.write(`R4.1c outside write (${target}): ${elapsed.toFixed(0)} ms\n`);
        expect(elapsed).toBeLessThan(BUDGET_MS);
      }
    });
  }, 180_000);

  it("exposes clean and dirty external deletions with Close and Recreate", async () => {
    await withStudioBrowser("external-delete", async ({ page, projectId, projectRoot, runtime }) => {
      const relativePath = "compositions/scene-1.html" as RelPath;
      const filename = "scene-1.html";
      const sourcePath = path.join(projectRoot, relativePath);
      const sourceBytes = await readFile(sourcePath);
      const projectRef = await runtime.foundation.infrastructure.workspace.readProjectRef(projectId as ProjectId);
      if (!projectRef) throw new Error("external deletion fixture has no project ref");
      const deletionReads: Array<{ status: number; body: string }> = [];
      const deletionReadsInFlight = new Set<Promise<void>>();
      const onDeletionResponse = (response: import("puppeteer-core").HTTPResponse) => {
        const url = new URL(response.url());
        if (response.request().method() !== "GET" || !url.pathname.endsWith("/files")) return;
        if (url.searchParams.get("path") !== relativePath) return;
        const read = response.text()
          .then((body) => { deletionReads.push({ status: response.status(), body }); })
          // A response observer is diagnostic only; the user-visible state and
          // status assertions below remain authoritative if the target swaps.
          .catch(() => undefined);
        deletionReadsInFlight.add(read);
      };
      page.on("response", onDeletionResponse);

      try {
        await openTreeSource(page, relativePath);
        deletionReads.length = 0;
        const beforeDeleteSeq = Number(await page.evaluate(() => document.documentElement.dataset.studioEventSeq ?? "0"));
        await rm(sourcePath);
        // fs.watch does not promise that every platform reports unlink. `observe`
        // is the production watcher's deterministic post-filesystem seam: it
        // samples the real absence, writes the real durable event and wakes SSE.
        await runtime.foundation.infrastructure.watcher.observe(projectRef, relativePath);
        await page.waitForFunction((before) =>
          Number(document.documentElement.dataset.studioEventSeq ?? "0") > before,
        { timeout: 10_000 }, beforeDeleteSeq);
        await expect.poll(() => deletionReads.at(-1)?.status, { timeout: 10_000 }).toBe(404);
        await page.waitForFunction(() => document.body.innerText.includes("This file was deleted outside the editor"), {
          timeout: 10_000,
        }).catch(async (cause) => {
          const state = await page.evaluate(() => ({
            text: document.body.innerText.slice(0, 1_500),
            alerts: [...document.querySelectorAll('[role="alert"]')].map((node) => node.textContent?.trim()),
          }));
          throw new Error(`external deletion did not reach the editor: ${JSON.stringify({ state, deletionReads })}`, { cause });
        });
        await page.waitForFunction(() => ["Recreate", "Close"].every((label) =>
          [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === label)));
        expect(await page.$$eval("button", (buttons) => buttons
          .filter((button) => button.textContent?.includes("Save"))
          .every((button) => (button as HTMLButtonElement).disabled))).toBe(true);
        await page.evaluate(() => {
          const asked: string[] = [];
          (window as unknown as { deletionExitPrompts: string[] }).deletionExitPrompts = asked;
          window.confirm = (message?: string) => { asked.push(message ?? ""); return false; };
        });
        await page.waitForFunction(() => document.documentElement.dataset.studioUnsavedCount === "1", {
          timeout: 10_000,
          polling: 16,
        });
        await page.click('a[href="/"]');
        expect(await page.evaluate(() =>
          (window as unknown as { deletionExitPrompts: string[] }).deletionExitPrompts.length)).toBe(1);
        expect(new URL(page.url()).pathname).not.toBe("/");
        await clickExactButton(page, "Close");
        await page.waitForFunction((label) => ![...document.querySelectorAll("button")]
          .some((button) => button.getAttribute("aria-label")?.startsWith(`Close ${label}`)),
        { timeout: 10_000 }, filename);

        await writeFile(sourcePath, sourceBytes);
        await runtime.foundation.infrastructure.watcher.observe(projectRef, relativePath);
        await openTreeSource(page, relativePath);
        const beforeDelete = await page.$eval(".cm-content", (element) => element.textContent ?? "");
        await page.locator(".cm-content").fill(`${beforeDelete}\n<!-- recreate-dirty-delete -->`);
        await page.waitForFunction(() => document.body.innerText.includes("Unsaved changes"));
        deletionReads.length = 0;
        const beforeDirtyDeleteSeq = Number(await page.evaluate(() => document.documentElement.dataset.studioEventSeq ?? "0"));
        await rm(sourcePath);
        await runtime.foundation.infrastructure.watcher.observe(projectRef, relativePath);
        await page.waitForFunction((before) =>
          Number(document.documentElement.dataset.studioEventSeq ?? "0") > before,
        { timeout: 10_000 }, beforeDirtyDeleteSeq);
        await expect.poll(() => deletionReads.at(-1)?.status, { timeout: 10_000 }).toBe(404);
        await page.waitForFunction(() => document.body.innerText.includes("This file was deleted outside the editor"));
        const recreateResponse = page.waitForResponse((response) =>
          response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/files"),
        { timeout: 10_000 });
        await clickExactButton(page, "Recreate");
        expect((await recreateResponse).ok()).toBe(true);
        await page.waitForFunction(() => !document.body.innerText.includes("This file was deleted outside the editor"));
        expect(await readFile(sourcePath, "utf8")).toContain("recreate-dirty-delete");
      } finally {
        page.off("response", onDeletionResponse);
        await Promise.all(deletionReadsInFlight);
      }
    });
  }, 180_000);

  it("uses keyboard-accessible dialogs for project file CRUD", async () => {
    await withStudioBrowser("file-crud-dialogs", async ({ page }) => {
      const newFile = await page.waitForSelector('button[aria-label="New file"]');
      await newFile!.focus();
      await newFile!.click();

      const dialog = await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
      const semantics = await dialog!.evaluate((element) => ({
        labelledBy: element.getAttribute("aria-labelledby"),
        describedBy: element.getAttribute("aria-describedby"),
        label: element.getAttribute("aria-labelledby")
          ? document.getElementById(element.getAttribute("aria-labelledby")!)?.textContent?.trim()
          : null,
        description: element.getAttribute("aria-describedby")
          ? document.getElementById(element.getAttribute("aria-describedby")!)?.textContent?.trim()
          : null,
      }));
      expect(semantics).toMatchObject({
        labelledBy: expect.any(String),
        describedBy: expect.any(String),
        label: "Create file",
        description: "Enter a project-relative path for the new file.",
      });
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("INPUT");

      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="dialog"]', { hidden: true });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "New file");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("New file");

      await page.click('button[aria-label="New file"]');
      await page.locator('[role="dialog"] input').fill("assets/dialog-file.txt");
      const created = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/entries"));
      const createdSnapshot = page.waitForResponse(async (response) => response.request().method() === "GET"
        && new URL(response.url()).pathname.endsWith("/studio-snapshot")
        && (await response.text()).includes('"path":"assets/dialog-file.txt"'));
      await page.keyboard.press("Enter");
      expect((await created).status()).toBe(201);
      expect((await createdSnapshot).ok()).toBe(true);

      await selectTreeEntry(page, "assets/dialog-file.txt");
      await page.click('button[aria-label="Rename selected entry"]');
      await page.waitForSelector('[role="dialog"]');
      expect(await page.$eval('[role="dialog"] input', (input) => (input as HTMLInputElement).value))
        .toBe("assets/dialog-file.txt");
      expect(await page.$eval('[role="dialog"] input', (input) => ({
        start: (input as HTMLInputElement).selectionStart,
        end: (input as HTMLInputElement).selectionEnd,
      }))).toEqual({ start: 0, end: "assets/dialog-file.txt".length });
      await page.keyboard.type("assets/dialog-renamed.txt");
      const renamed = page.waitForResponse((response) => response.request().method() === "PATCH"
        && new URL(response.url()).pathname.endsWith("/entries"));
      const renamedSnapshot = page.waitForResponse(async (response) => response.request().method() === "GET"
        && new URL(response.url()).pathname.endsWith("/studio-snapshot")
        && (await response.text()).includes('"path":"assets/dialog-renamed.txt"')).catch(() => null);
      await page.keyboard.press("Enter");
      const renamedResponse = await renamed;
      if (!renamedResponse.ok()) {
        throw new Error(`rename failed (${renamedResponse.status()}): ${await renamedResponse.text()}`);
      }
      const renamedPayload = await renamedResponse.json() as { revision?: number; changeSeq?: number | null };
      const renamedSnapshotResponse = await renamedSnapshot;
      expect(renamedSnapshotResponse?.ok()).toBe(true);
      const renamedSnapshotPayload = await renamedSnapshotResponse?.json() as {
        eventCursor?: number;
        projectRevision?: number;
      } | undefined;

      try {
        await selectTreeEntry(page, "assets/dialog-renamed.txt");
      } catch (cause) {
        const rendered = await page.evaluate(() => ({
          projectRevision: document.querySelector("[data-project-revision]")?.getAttribute("data-project-revision"),
          paths: [...document.querySelectorAll("button[data-file-path]")]
            .map((button) => button.getAttribute("data-file-path")),
          error: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
        }));
        throw new Error(`renamed tree did not render: ${JSON.stringify({ renamedPayload, renamedSnapshotPayload, rendered })}`, { cause });
      }
      await page.click('button[aria-label="Delete selected entry"]');
      await page.waitForFunction(() => document.body.innerText.includes("Delete dialog-renamed.txt?"));
      expect(await page.$eval('[role="dialog"]', (element) => element.getAttribute("aria-describedby"))).toBeTruthy();
      const prepared = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname.endsWith("/entries/deletions"));
      const deleted = page.waitForResponse((response) => response.request().method() === "POST"
        && /\/entries\/deletions\/[^/]+$/u.test(new URL(response.url()).pathname));
      await page.keyboard.press("Enter");
      expect((await prepared).ok()).toBe(true);
      expect((await deleted).ok()).toBe(true);
    });
  }, 180_000);
});
