// @vitest-environment node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withStudioBrowser } from "../support/browser-studio";

async function clickExactButton(page: import("puppeteer-core").Page, label: string): Promise<void> {
  await page.waitForFunction((text) => [...document.querySelectorAll("button")]
    .some((candidate) => candidate.textContent?.trim() === text && !(candidate as HTMLButtonElement).disabled),
  { timeout: 20_000 }, label).catch(async (cause) => {
    const state = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll("button")].map((button) => ({
        text: button.textContent?.trim(), disabled: button.disabled, selected: button.getAttribute("aria-selected"),
      })).filter((button) => button.text),
      body: document.body.innerText.slice(0, 2_000),
    }));
    throw new Error(`button ${JSON.stringify(label)} was unavailable: ${JSON.stringify(state)}`, { cause });
  });
  for (const button of await page.$$("button")) {
    if (await button.evaluate((node) => node.textContent?.trim()) !== label) continue;
    if (await button.evaluate((node) => (node as HTMLButtonElement).disabled)) continue;
    await button.click();
    return;
  }
  throw new Error(`button ${JSON.stringify(label)} disappeared before click`);
}

async function awaitSettingsWrite(
  page: import("puppeteer-core").Page,
  action: () => Promise<void>,
): Promise<number> {
  const response = page.waitForResponse((candidate) => candidate.request().method() === "PATCH"
    && new URL(candidate.url()).pathname.endsWith("/preview-settings"),
  { timeout: 20_000 });
  await action();
  const written = await response;
  const payload = await written.json() as { changeSeq?: number; error?: unknown };
  if (!written.ok() || payload.changeSeq === undefined) {
    throw new Error(`preview settings write failed (${written.status()}): ${JSON.stringify(payload)}`);
  }
  await page.waitForFunction((seq) => Number(
    (document.querySelector("[data-preview-change-seq]") as HTMLElement | null)?.dataset.previewChangeSeq,
  ) >= seq, { timeout: 20_000, polling: 16 }, payload.changeSeq);
  return payload.changeSeq;
}

async function awaitScriptWrites(
  page: import("puppeteer-core").Page,
  count: number,
  action: () => Promise<void>,
): Promise<void> {
  const responses: import("puppeteer-core").HTTPResponse[] = [];
  let settle!: () => void;
  let fail!: (cause: Error) => void;
  const completed = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const timeout = setTimeout(() => fail(new Error(`timed out waiting for ${count} script writes`)), 30_000);
  const onResponse = (response: import("puppeteer-core").HTTPResponse) => {
    if (response.request().method() !== "PATCH"
      || !new URL(response.url()).pathname.endsWith("/script")) return;
    responses.push(response);
    if (responses.length === count) settle();
  };
  page.on("response", onResponse);
  try {
    await action();
    await completed;
  } finally {
    clearTimeout(timeout);
    page.off("response", onResponse);
  }
  for (const response of responses) {
    const payload = await response.json() as { changeSeq?: number; error?: unknown };
    if (!response.ok() || payload.changeSeq === undefined) {
      throw new Error(`script write failed (${response.status()}): ${JSON.stringify(payload)}`);
    }
  }
}

async function waitForFrameMarker(
  page: import("puppeteer-core").Page,
  selector: string,
  text?: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let observedExternalHosts: unknown[] = [];
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let found = false;
      try {
        const observed = await frame.evaluate((query, needle) => {
          const element = document.querySelector(query);
          return {
            found: element !== null && (needle === undefined || element.textContent?.includes(needle) === true),
            hosts: [...document.querySelectorAll<HTMLElement>("[data-composition-src]")].map((host) => ({
              url: location.href,
              id: host.dataset.compositionId ?? null,
              src: host.dataset.compositionSrc ?? null,
              children: host.children.length,
              html: host.innerHTML.slice(0, 240),
            })),
          };
        }, selector, text);
        found = observed.found;
        if (observed.hosts.some((host) => host.id !== "scene-1") || observed.hosts.length > 1) {
          observedExternalHosts = observed.hosts;
        } else if (observedExternalHosts.length === 0 && observed.hosts.length > 0) {
          observedExternalHosts = observed.hosts;
        }
      } catch {
        // The preview is double-buffered; a frame from page.frames() may detach
        // between enumeration and evaluation while the edited frame is swapped in.
        found = false;
      }
      if (found) return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  const frames = await Promise.all(page.frames().map(async (frame) => {
    try {
      return await frame.evaluate(() => ({
        url: location.href,
        body: document.body?.innerText.slice(0, 500) ?? "",
        previewError: (document.querySelector("[data-preview-error]") as HTMLElement | null)?.dataset.previewError ?? null,
        previewHealth: (document.querySelector("[data-preview-health]") as HTMLElement | null)?.dataset.previewHealth ?? null,
        previewChangeSeq: (document.querySelector("[data-preview-change-seq]") as HTMLElement | null)?.dataset.previewChangeSeq ?? null,
        compositions: [...document.querySelectorAll("[data-composition-id]")].map((node) => ({
          id: node.getAttribute("data-composition-id"),
          src: node.getAttribute("data-composition-src"),
          start: node.getAttribute("data-start"),
        })),
      }));
    } catch {
      return { url: frame.url(), body: "detached", compositions: [] };
    }
  }));
  throw new Error(`preview frame did not expose ${selector}${text ? ` containing ${text}` : ""}: ${JSON.stringify({ frames, observedExternalHosts })}`);
}

describe("storyboard inspector actions", () => {
  it("loads a local image thumbnail through the browser-safe project asset route", async () => {
    await withStudioBrowser("inspector-media-thumbnail", async ({ page, projectId }) => {
      await clickExactButton(page, "Video Scene");
      const image = await page.waitForSelector(
        'img[data-scene-media-thumbnail-state="loaded"]',
        { timeout: 20_000 },
      );
      if (!image) throw new Error("scene inspector exposed no image thumbnail");
      const thumbnail = await image.evaluate((node) => ({
        complete: (node as HTMLImageElement).complete,
        naturalWidth: (node as HTMLImageElement).naturalWidth,
        pathname: new URL((node as HTMLImageElement).src).pathname,
      }));
      expect(thumbnail.pathname).toBe(
        `/api/v1/projects/${encodeURIComponent(projectId)}/assets/assets/thumbnail.png`,
      );
      expect(thumbnail.complete).toBe(true);
      expect(thumbnail.naturalWidth).toBeGreaterThan(0);
    }, async (project) => {
      await mkdir(path.join(project.root, "assets"), { recursive: true });
      await writeFile(
        path.join(project.root, "assets", "thumbnail.png"),
        Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+waGzAAAAAElFTkSuQmCC", "base64"),
      );
      const sourcePath = path.join(project.root, project.sceneSource);
      const source = await readFile(sourcePath, "utf8");
      await writeFile(
        sourcePath,
        source.replace("    <h1", '    <img src="../assets/thumbnail.png?rev=1#frame" alt="" />\n    <h1'),
        "utf8",
      );
    });
  }, 60_000);

  it("makes Preview, Motion, Templates and Music persistently affect the video", async () => {
    await withStudioBrowser("inspector-actions", async ({ page, projectRoot }) => {
      await page.waitForFunction(() => [...document.querySelectorAll("[data-player-host-id] iframe")]
        .some((frame) => (frame as HTMLElement).style.opacity === "1"),
      { timeout: 30_000, polling: 50 });
      await clickExactButton(page, "Video Scene");

      // Preview editor: enable the light treatment and wait for the rebuilt
      // composition, rather than merely trusting the checkbox's local state.
      await clickExactButton(page, "Look & subtitles");
      await awaitSettingsWrite(page, async () => {
        await page.waitForFunction(() => {
          const label = [...document.querySelectorAll("label")]
            .find((candidate) => candidate.textContent?.trim() === "Apply lighting overlay");
          const input = label?.htmlFor ? document.getElementById(label.htmlFor) as HTMLInputElement | null : null;
          if (!input || input.checked) return false;
          input.click();
          return true;
        }, { timeout: 10_000 });
      });
      await waitForFrameMarker(page, "#hf-preview-tone");
      let settings = JSON.parse(await readFile(path.join(projectRoot, "preview-settings.json"), "utf8")) as {
        tone?: { enabled?: boolean };
        scenes?: Record<string, { motionPreset?: string }>;
        bgm?: { enabled?: boolean; track?: { path?: string } | null };
      };
      expect(settings.tone?.enabled).toBe(true);

      // Motion: a recipe must be present in the rebuilt render document and on
      // disk. A vendored library alone is not a visible video edit.
      await clickExactButton(page, "Motion & sound");
      await awaitSettingsWrite(page, () => clickExactButton(page, "drift"));
      await waitForFrameMarker(page, "#hf-preview-settings", "hf-scene-drift");
      settings = JSON.parse(await readFile(path.join(projectRoot, "preview-settings.json"), "utf8"));
      expect(settings.scenes?.["scene-1"]?.motionPreset).toBe("drift");

      // Templates: installing the first available catalog item must create and
      // select a real second storytelling beat in the storyboard.
      const scenesBefore = await page.$$eval("[data-storyboard-scene-id]", (cards) => cards.length);
      await clickExactButton(page, "Add scene");
      await page.waitForSelector("[data-catalog-item]", { timeout: 20_000 }).catch(async (cause) => {
        const state = await page.evaluate(() => ({
          text: document.body.innerText.slice(-2_000),
          empty: document.querySelector("[data-catalog-empty]")?.outerHTML ?? null,
          alert: document.querySelector('[role="alert"]')?.textContent ?? null,
        }));
        throw new Error(`catalog did not expose an installable item: ${JSON.stringify(state)}`, { cause });
      });
      const titleCardFetched = page.waitForResponse((candidate) =>
        new URL(candidate.url()).pathname.endsWith("/templates/title-card/scene.html"), { timeout: 10_000 });
      const catalogPrepared = page.waitForResponse((candidate) => candidate.request().method() === "POST"
        && /\/catalog-items\/plans$/u.test(new URL(candidate.url()).pathname), { timeout: 30_000 });
      const mountButton = await page.$("[data-catalog-item] button:not(:disabled)");
      if (!mountButton) throw new Error("catalog item has no enabled mount action");
      await mountButton.click();
      const prepareResponse = await catalogPrepared;
      const preparePayload = await prepareResponse.json() as { status?: string; error?: unknown };
      if (!prepareResponse.ok()) {
        throw new Error(`catalog prepare failed (${prepareResponse.status()}): ${JSON.stringify(preparePayload)}`);
      }
      const catalogExecuted = page.waitForResponse((candidate) => candidate.request().method() === "POST"
        && /\/catalog-items\/plans\/[^/]+$/u.test(new URL(candidate.url()).pathname), { timeout: 30_000 });
      if (preparePayload.status === "choice_required") {
        await page.waitForSelector('[role="group"] button', { timeout: 10_000 });
        const choiceButton = await page.$('[role="group"] button:not(:disabled)');
        if (!choiceButton) throw new Error(`catalog choice was required but no action was available: ${JSON.stringify(preparePayload)}`);
        await choiceButton.click();
      }
      const catalogResponse = await catalogExecuted;
      const catalogPayload = await catalogResponse.json() as { changeSeq?: number; error?: unknown };
      if (!catalogResponse.ok() || catalogPayload.changeSeq === undefined) {
        throw new Error(`catalog install failed (${catalogResponse.status()}): ${JSON.stringify(catalogPayload)}`);
      }
      await page.waitForFunction((count) => document.querySelectorAll("[data-storyboard-scene-id]").length > count,
        { timeout: 30_000, polling: 50 }, scenesBefore);
      const titleCardResponse = await titleCardFetched;
      expect([200, 304]).toContain(titleCardResponse.status());
      const titleCardBody = await titleCardResponse.text().catch(async (cause) => {
        if (titleCardResponse.status() !== 304) throw cause;
        return page.evaluate(async (sourceUrl) => {
          const url = new URL(sourceUrl);
          url.searchParams.set("browser-proof", "1");
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) throw new Error(`template proof request failed: ${response.status}`);
          return response.text();
        }, titleCardResponse.url());
      });
      expect(titleCardBody).toContain('id="title-card-template"');
      const cards = await page.$$('[data-storyboard-scene-id]');
      expect(cards.length).toBeGreaterThan(scenesBefore);
      expect(await readFile(path.join(projectRoot, "index.html"), "utf8")).toMatch(/data-composition-src=/u);
      await cards.at(-1)!.click();
      await waitForFrameMarker(page, ".title-card__headline", "Your headline");

      // Two quick edits to the newly mounted template used to race on the same
      // file hash: the second PATCH saw the pre-first-write hash and failed 409.
      // The inspector queue must preserve both user-visible lines in order.
      await clickExactButton(page, "Scene");
      const headline = await page.waitForSelector('textarea[title$="title-card-headline"]', { timeout: 20_000 });
      const subhead = await page.waitForSelector('textarea[title$="title-card-subhead"]', { timeout: 20_000 });
      if (!headline || !subhead) throw new Error("mounted title-card copy is not editable");
      await awaitScriptWrites(page, 2, async () => {
        await headline.focus();
        await page.keyboard.down("Control");
        await page.keyboard.press("A");
        await page.keyboard.up("Control");
        await headline.type("ODYSSEUS");
        await subhead.focus();
        await page.keyboard.down("Control");
        await page.keyboard.press("A");
        await page.keyboard.up("Control");
        await subhead.type("A changed return");
        await page.keyboard.press("Tab");
      });
      expect(await page.$eval("body", (body) => body.innerText.includes("the project changed since it was read")))
        .toBe(false);
      const titleCardSource = await readFile(
        path.join(projectRoot, "templates", "title-card", "scene.html"),
        "utf8",
      );
      expect(titleCardSource).toContain("ODYSSEUS");
      expect(titleCardSource).toContain("A changed return");

      // Music: install the deterministic Ambient bed. The generated WAV and
      // injected audio element are the durable/renderable effect of this tab.
      await clickExactButton(page, "Music");
      await page.waitForFunction(() => [...document.querySelectorAll("span")]
        .some((node) => node.textContent?.trim() === "Ambient"), { timeout: 20_000 });
      const installed = page.waitForResponse((candidate) => candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname.endsWith("/bgm"), { timeout: 30_000 });
      await page.evaluate(() => {
        const label = [...document.querySelectorAll("span")]
          .find((node) => node.textContent?.trim() === "Ambient");
        const row = label?.closest(".rounded-md");
        const use = [...(row?.querySelectorAll("button") ?? [])]
          .find((button) => button.textContent?.trim() === "Use") as HTMLButtonElement | undefined;
        if (!use || use.disabled) throw new Error("Ambient bed has no enabled Use action");
        use.click();
      });
      const musicResponse = await installed;
      const musicPayload = await musicResponse.json() as { changeSeq?: number; error?: unknown };
      if (!musicResponse.ok() || musicPayload.changeSeq === undefined) {
        throw new Error(`music install failed (${musicResponse.status()}): ${JSON.stringify(musicPayload)}`);
      }
      await page.waitForFunction((seq) => Number(
        (document.querySelector("[data-preview-change-seq]") as HTMLElement | null)?.dataset.previewChangeSeq,
      ) >= seq, { timeout: 30_000, polling: 25 }, musicPayload.changeSeq);
      settings = JSON.parse(await readFile(path.join(projectRoot, "preview-settings.json"), "utf8"));
      expect(settings.bgm?.enabled).toBe(true);
      expect(settings.bgm?.track?.path).toBe("preview-assets/bgm/ambient.wav");
      expect((await stat(path.join(projectRoot, "preview-assets", "bgm", "ambient.wav"))).size).toBeGreaterThan(44);
      await waitForFrameMarker(page, "audio#hf-preview-bgm");
    });
  }, 180_000);
});
