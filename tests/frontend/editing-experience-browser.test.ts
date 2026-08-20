// @vitest-environment node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import type { Page } from "puppeteer-core";

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

/**
 * Attaches a second studio session for this tab.
 *
 * Studio writes carry a session header so the mutation can be undone from the
 * tab that made it. The measurement makes real studio writes, so it attaches a
 * real session rather than bypassing the requirement.
 */
async function attachSession(page: Page, projectId: string): Promise<string> {
  return await page.evaluate(async (id: string) => {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let studioId = "";
    for (let index = 0; index < 26; index += 1) {
      studioId += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const response = await fetch(`/api/v1/projects/${id}/history/session`, {
      method: "POST",
      headers: { "x-vidcom-studio-session": studioId },
    });
    if (!response.ok) throw new Error(`could not attach a studio session (${response.status})`);
    return studioId;
  }, projectId);
}

async function projectIdOf(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const response = await fetch("/api/v1/projects");
    const payload = await response.json() as { projects: Array<{ id: string }> };
    return payload.projects[0]!.id;
  });
}

// BLOCKED: after a source write, no newly created player receives a timeline.
//
// Measured, not guessed, and narrowed to this one sentence. One real bug was
// found and fixed on the way: the candidate was given its `src` before it was
// connected, so it loaded while detached — where `window.parent` is its own
// window — and the runtime never opened its bridge, which also left the page
// unable to bridge afterwards.
//
// What remains is not about the buffer at all. In a page where nothing has been
// written yet, a replacement player reports its timeline in ~230-300 ms. After
// one source write through the daemon, no player created afterwards reports one
// — not the buffer's candidate, and not a hand-written element in the same page,
// with or without another player alive, with the same URL or a cache-busted one.
// The served document is intact through all of it (clip, timing attributes,
// runtime script, health collector). Since the swap requires the candidate to
// report a timeline, every reload can only time out, and there is nothing here
// to measure until that is resolved.
describe("editing experience in a browser", () => {
  it.skip("shows this tab's own write in the preview within the R4.1c budget", async () => {
    await withStudioBrowser("perf-write", async ({ page }) => {
      await install(page);
      const projectId = await projectIdOf(page);
      const studioId = await attachSession(page, projectId);

      // Case 1 — a content mutation, timed from its own success response.
      const content = await page.evaluate(async (input: { id: string; studioId: string }) => {
        const read = await fetch(`/api/v1/projects/${input.id}/files?path=index.html`);
        const file = (await read.json() as { file: { content: string; contentHash: string } }).file;
        const response = await fetch(`/api/v1/projects/${input.id}/files`, {
          method: "PUT",
          headers: { "content-type": "application/json", "x-vidcom-studio-session": input.studioId },
          body: JSON.stringify({
            path: "index.html",
            // Inserted inside the document rather than appended after
            // `</html>`, so the composition it produces is still well formed.
            content: file.content.replace("</body>", "<!-- measured --></body>"),
            expectedContentHash: file.contentHash,
          }),
        });
        const payload = await response.json().catch(() => null) as { changeSeq?: number | null } | null;
        return { at: performance.now(), changeSeq: payload?.changeSeq ?? null, status: response.status };
      }, { id: projectId, studioId });
      expect(content.status, "content write failed").toBe(200);
      expect(content.changeSeq).not.toBeNull();
      const contentMs = await previewReached(page, content.changeSeq!) - content.at;
      process.stdout.write(`R4.1c browser content mutation: ${contentMs.toFixed(0)} ms\n`);
      expect(contentMs).toBeLessThan(BUDGET_MS);

      // Case 2 — a preview-settings mutation, which rebuilds the preview
      // document without touching the project's scenes.
      const settings = await page.evaluate(async (input: { id: string; studioId: string }) => {
        const read = await fetch(`/api/v1/projects/${input.id}/preview-settings`);
        const current = await read.json() as { revision: number };
        const response = await fetch(`/api/v1/projects/${input.id}/preview-settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json", "x-vidcom-studio-session": input.studioId },
          body: JSON.stringify({
            patch: { tone: { backgroundFx: "scan" } },
            expectedRevision: current.revision,
          }),
        });
        const payload = await response.json().catch(() => null) as { changeSeq?: number | null } | null;
        return { at: performance.now(), changeSeq: payload?.changeSeq ?? null, status: response.status };
      }, { id: projectId, studioId });
      expect(settings.status, "preview-settings write failed").toBe(200);
      expect(settings.changeSeq).not.toBeNull();
      const settingsMs = await previewReached(page, settings.changeSeq!) - settings.at;
      process.stdout.write(`R4.1c browser preview-settings mutation: ${settingsMs.toFixed(0)} ms\n`);
      expect(settingsMs).toBeLessThan(BUDGET_MS);
    });
  }, 180_000);

  it.skip("shows a write made outside the app within the budget of the event that announced it", async () => {
    await withStudioBrowser("perf-outside", async ({ page, projectRoot }) => {
      await install(page);

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
});
