// @vitest-environment node

import type { Browser, Page } from "puppeteer-core";
import { describe, expect, it } from "vitest";

import { requireBrowser } from "../support/browser-harness";
import {
  CAPTION_PARITY_POINTS,
  captionRuntimeBrowserDocument,
} from "./fixtures/caption-runtime-browser";

const FPS = 30_000 / 1_001;

async function probe(page: Page, rootSeconds: number): Promise<{ active: string[]; color: string | null }> {
  return page.evaluate(({ frame }) => {
    window.postMessage({
      source: "hf-preview",
      type: "timeline",
      fps: { numerator: 30_000, denominator: 1_001 },
    }, "*");
    window.postMessage({ source: "hf-preview", type: "state", frame }, "*");
    const active = [...document.querySelectorAll<HTMLElement>(".caption .w.active")];
    return {
      active: active.map((word) => word.textContent ?? ""),
      color: active[0] ? getComputedStyle(active[0]).color : null,
    };
  }, { frame: rootSeconds * FPS });
}

describe("caption runtime real-browser probes", () => {
  it("follows play, seek and rate-driven state at a non-zero scene start with preview/render parity", async () => {
    const available = await requireBrowser();
    if (!available.run) {
      process.stdout.write(`${available.message}\n`);
      return;
    }
    const puppeteer = await import("puppeteer-core");
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        executablePath: available.chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const results: Record<"preview" | "render", Array<{ active: string[]; color: string | null }>> = {
        preview: [],
        render: [],
      };
      for (const mode of ["preview", "render"] as const) {
        const page = await browser.newPage();
        await page.setContent(captionRuntimeBrowserDocument(mode), { waitUntil: "load" });
        for (const point of CAPTION_PARITY_POINTS) {
          results[mode].push(await probe(page, point.rootSeconds));
        }
        await page.close();
      }

      const expected = CAPTION_PARITY_POINTS.map((point) => ({
        active: [point.active],
        color: "rgb(18, 171, 52)",
      }));
      expect(results.preview).toEqual(expected);
      expect(results.render).toEqual(expected);
      expect(results.render).toEqual(results.preview);
    } finally {
      await browser?.close();
    }
  }, 30_000);
});
