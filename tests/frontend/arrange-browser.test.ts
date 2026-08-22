// @vitest-environment node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withStudioBrowser } from "../support/browser-studio";

async function clickExactButton(page: import("puppeteer-core").Page, label: string): Promise<void> {
  await page.waitForFunction((text) => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === text) as HTMLButtonElement | undefined;
    if (!button) return false;
    button.click();
    return true;
  }, { timeout: 10_000 }, label);
}

describe("direct preview arrangement", () => {
  it("cross-checks a stable target and persists one drag as one position mutation", async () => {
    await withStudioBrowser("arrange-preview", async ({ page, projectId, projectRoot }) => {
      const scenePath = path.join(projectRoot, "compositions", "scene-1.html");
      await clickExactButton(page, "Arrange elements");
      const overlay = await page.waitForSelector("[data-arrange-overlay]", { timeout: 10_000 });
      const bounds = await overlay!.boundingBox();
      if (!bounds) throw new Error("arrange overlay has no bounds");
      expect(await overlay!.evaluate((node) => node.getAttribute("data-arrange-selected-scene-id")))
        .toBe("scene-1");
      await page.focus('[data-slot="slider-thumb"][aria-label="Seek"]');
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      const beforeArrange = await page.$eval('[data-slot="slider-thumb"][aria-label="Seek"]', (node) =>
        Number(node.getAttribute("aria-valuenow")));
      expect(beforeArrange).toBeGreaterThan(0);

      let mutations = 0;
      page.on("request", (request) => {
        if (request.method() === "PUT" && new URL(request.url()).pathname.endsWith("/elements/headline/position")) mutations += 1;
      });
      const response = page.waitForResponse((candidate) => candidate.request().method() === "PUT"
        && new URL(candidate.url()).pathname === `/api/v1/projects/${projectId}/scenes/scene-1/elements/headline/position`,
      { timeout: 5_000 });
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.45);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height * 0.45 + 24, { steps: 5 });
      const duringArrange = await page.$eval('[data-slot="slider-thumb"][aria-label="Seek"]', (node) =>
        Number(node.getAttribute("aria-valuenow")));
      expect(duringArrange).toBeGreaterThanOrEqual(beforeArrange);
      const releasedAt = Date.now();
      await page.mouse.up();
      const saved = await response.catch(async (cause) => {
        const state = await page.evaluate(() => ({
          text: document.body.innerText.slice(0, 1_200),
          target: document.querySelector("[data-arrange-target]")?.getAttribute("data-arrange-target") ?? null,
          alert: document.querySelector('[role="alert"]')?.textContent ?? null,
        }));
        throw new Error(`arrange mutation was not sent: ${JSON.stringify({ state, mutations })}`, { cause });
      });
      const payload = await saved.json() as { changeSeq: number; error?: unknown };
      if (!saved.ok()) throw new Error(`position mutation failed (${saved.status()}): ${JSON.stringify(payload)}`);
      const savedAt = Date.now();
      await page.waitForFunction((seq) => Number(
        (document.querySelector("[data-preview-change-seq]") as HTMLElement | null)?.dataset.previewChangeSeq,
      ) >= seq, { timeout: 20_000, polling: 16 }, payload.changeSeq);
      const paintedAt = Date.now();
      process.stdout.write(`Arrange pointerup→response=${savedAt - releasedAt} ms; response→paint=${paintedAt - savedAt} ms; total=${paintedAt - releasedAt} ms\n`);
      expect(paintedAt - releasedAt).toBeLessThan(500);
      expect(mutations).toBe(1);
      const written = await readFile(scenePath, "utf8");
      expect(written).toContain("data-vidcom-layout-offset");
      expect(written).toContain("--vidcom-layout-x:");
      expect(written).toContain("--vidcom-layout-y:");
    });
  }, 60_000);
});
