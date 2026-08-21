// @vitest-environment node

import { source as axeSource } from "axe-core";
import type { Page } from "puppeteer-core";
import { describe, expect, it } from "vitest";

import { withStudioBrowser } from "../support/browser-studio";

interface BlockingViolation {
  id: string;
  impact: string | null;
  help: string;
  targets: string[][];
  html: string[];
  failureSummaries: Array<string | null>;
}

async function audit(page: Page, flow: string): Promise<void> {
  const violations = await page.evaluate(async (label) => {
    const axe = (window as unknown as {
      axe: {
        run(context: Document, options: object): Promise<{
          violations: Array<{
            id: string;
            impact: string | null;
            help: string;
            nodes: Array<{ target: string[]; html: string; failureSummary: string | null }>;
          }>;
        }>;
      };
    }).axe;
    const result = await axe.run(document, {
      resultTypes: ["violations"],
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    });
    document.documentElement.dataset.accessibilityFlow = label;
    return result.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        targets: violation.nodes.map((node) => node.target),
        html: violation.nodes.map((node) => node.html),
        failureSummaries: violation.nodes.map((node) => node.failureSummary),
      }));
  }, flow) as BlockingViolation[];

  expect(violations, `${flow} has critical/serious accessibility violations`).toEqual([]);
}

async function activateTab(page: Page, label: string): Promise<void> {
  const tabs = await page.$$('[role="tab"]');
  let clicked = false;
  for (const tab of tabs) {
    if (await tab.evaluate((candidate) => candidate.textContent?.trim()) !== label) continue;
    await tab.click();
    clicked = true;
    break;
  }
  if (!clicked) throw new Error(`studio tab ${label} was not found`);
  await page.waitForFunction((text) => [...document.querySelectorAll('[role="tab"]')]
    .some((candidate) => candidate.textContent?.trim() === text && candidate.getAttribute("aria-selected") === "true"),
  {}, label);
}

describe("studio accessibility gate", () => {
  it("has no critical or serious axe violations across critical studio flows", async () => {
    await withStudioBrowser("accessibility", async ({ page }) => {
      await page.addScriptTag({ content: axeSource });

      await audit(page, "code editor");
      await page.click('button[aria-label="New file"]');
      await page.waitForSelector('[role="dialog"]');
      await page.$eval('[role="dialog"]', async (dialog) => {
        await Promise.all(dialog.getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => undefined)));
      });
      await audit(page, "file CRUD dialog");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="dialog"]', { hidden: true });

      await activateTab(page, "Video Scene");
      await audit(page, "scene editor");
      await activateTab(page, "AI Composer");
      await audit(page, "AI composer");
    });
  }, 180_000);
});
