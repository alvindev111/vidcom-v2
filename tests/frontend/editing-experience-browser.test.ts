// @vitest-environment node

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Page } from "puppeteer-core";
import { describe, expect, it } from "vitest";

import type { ProjectId, RelPath } from "@vidcom/contracts";

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
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (response.request().method() !== "GET" || !url.pathname.endsWith("/files")) return;
        if (url.searchParams.get("path") !== relativePath) return;
        void response.text().then((body) => deletionReads.push({ status: response.status(), body }));
      });

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
      await page.$eval('a[href="/"]', (link) => (link as HTMLAnchorElement).click());
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
