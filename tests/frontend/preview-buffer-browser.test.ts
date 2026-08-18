// @vitest-environment node

import type { Browser } from "puppeteer-core";
import { describe, expect, it } from "vitest";

import { requireBrowser } from "../support/browser-harness";
import { startPreviewBufferBrowserFixture } from "./fixtures/preview-buffer-browser-server";

interface ProbeResult {
  kind: string;
  reason?: string;
  visibleChangeSeq?: number;
  health?: {
    health: {
      scriptErrors: number;
      resourceErrors: number;
    };
  };
}

interface ProbeSnapshot {
  hostId: string;
  activePlayers: number;
  maxActivePlayers: number;
  visibleSeq: number;
  transport: { time: number; paused: boolean; rate: number; muted: boolean };
}

interface PreviewProbe {
  mount(): Promise<ProbeResult>;
  setTransport(input: { time: number; paused: boolean; rate: number; muted: boolean }): void;
  reload(input: { target: number; served: number; duration?: number; variant?: string; delay?: number }): Promise<ProbeResult>;
  snapshot(): ProbeSnapshot;
  dispose(): void;
}

describe("preview buffer real-browser probes", () => {
  it("keeps transport and the live frame through browser failures, races and teardown", async () => {
    const available = await requireBrowser();
    if (!available.run) {
      process.stdout.write(`${available.message}\n`);
      return;
    }
    const fixture = await startPreviewBufferBrowserFixture();
    let browser: Browser | null = null;
    try {
      const puppeteer = await import("puppeteer-core");
      browser = await puppeteer.launch({
        executablePath: available.chromePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await browser.newPage();
      await page.goto(fixture.url, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => "previewProbe" in window);

      const mounted = await page.evaluate(() => (window as unknown as { previewProbe: PreviewProbe }).previewProbe.mount());
      expect(mounted).toMatchObject({ kind: "mounted", visibleChangeSeq: 1 });
      const hostId = await page.evaluate(() =>
        (window as unknown as { previewProbe: PreviewProbe }).previewProbe.snapshot().hostId);

      await page.evaluate(() => (window as unknown as { previewProbe: PreviewProbe }).previewProbe.setTransport({
        time: 0, paused: false, rate: 1.5, muted: true,
      }));
      await expect(page.evaluate(() => (window as unknown as { previewProbe: PreviewProbe }).previewProbe.reload({
        target: 2, served: 2, duration: 4,
      }))).resolves.toMatchObject({ kind: "swapped", visibleChangeSeq: 2 });
      expect(await page.evaluate(() =>
        (window as unknown as { previewProbe: PreviewProbe }).previewProbe.snapshot().transport))
        .toEqual({ time: 0, paused: false, rate: 1.5, muted: true });

      await page.evaluate(() => (window as unknown as { previewProbe: PreviewProbe }).previewProbe.setTransport({
        time: 8, paused: true, rate: 1.25, muted: false,
      }));
      await page.evaluate(() => (window as unknown as { previewProbe: PreviewProbe }).previewProbe.reload({
        target: 3, served: 3, duration: 3,
      }));
      expect(await page.evaluate(() =>
        (window as unknown as { previewProbe: PreviewProbe }).previewProbe.snapshot().transport))
        .toEqual({ time: 3, paused: true, rate: 1.25, muted: false });

      const missing = await page.evaluate(() =>
        (window as unknown as { previewProbe: PreviewProbe }).previewProbe.reload({
          target: 4, served: 4, variant: "missing-scene",
        }));
      expect(missing).toMatchObject({ kind: "rejected", reason: "preview_unhealthy" });
      expect(await page.evaluate(() =>
        (window as unknown as { previewProbe: PreviewProbe }).previewProbe.snapshot().visibleSeq)).toBe(3);

      const script = await page.evaluate(() =>
        (window as unknown as { previewProbe: PreviewProbe }).previewProbe.reload({
          target: 5, served: 5, variant: "script-error",
        }));
      expect(script).toMatchObject({ kind: "rejected", health: { health: { scriptErrors: 1 } } });
      const resource = await page.evaluate(() =>
        (window as unknown as { previewProbe: PreviewProbe }).previewProbe.reload({
          target: 6, served: 6, variant: "resource-404",
        }));
      expect(resource).toMatchObject({ kind: "rejected", health: { health: { resourceErrors: 1 } } });

      const race = await page.evaluate(async () => {
        const probe = (window as unknown as { previewProbe: PreviewProbe }).previewProbe;
        const a = probe.reload({ target: 7, served: 7, delay: 300 });
        const b = probe.reload({ target: 8, served: 8, delay: 180 });
        const duplicateB = probe.reload({ target: 8, served: 8 });
        const c = probe.reload({ target: 9, served: 9 });
        return Promise.all([a, b, duplicateB, c]);
      });
      expect(race.map((result) => result.kind)).toEqual(["superseded", "superseded", "coalesced", "swapped"]);

      const newer = await page.evaluate(async () => {
        const probe = (window as unknown as { previewProbe: PreviewProbe }).previewProbe;
        const first = await probe.reload({ target: 10, served: 11 });
        const duplicate = await probe.reload({ target: 11, served: 11 });
        return [first, duplicate];
      });
      expect(newer).toMatchObject([
        { kind: "swapped", visibleChangeSeq: 11 },
        { kind: "coalesced", visibleChangeSeq: 11 },
      ]);

      const teardown = await page.evaluate(async () => {
        const probe = (window as unknown as { previewProbe: PreviewProbe }).previewProbe;
        const pending = probe.reload({ target: 12, served: 12, delay: 300 });
        probe.dispose();
        return { result: await pending, snapshot: probe.snapshot() };
      });
      expect(teardown).toMatchObject({ result: { kind: "disposed" }, snapshot: { activePlayers: 0 } });
      expect(teardown.snapshot.hostId).toBe(hostId);
      expect(teardown.snapshot.maxActivePlayers).toBeLessThanOrEqual(2);
    } finally {
      await browser?.close();
      await fixture.close();
    }
  }, 30_000);
});
