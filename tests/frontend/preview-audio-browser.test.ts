// @vitest-environment node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { withStudioBrowser } from "../support/browser-studio";

function toneWav(seconds = 30, sampleRate = 16_000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 440) * 3_000), 44 + index * 2);
  }
  return bytes;
}

async function prepareToneProject(project: { root: string; sceneSource: string }): Promise<void> {
  await mkdir(path.join(project.root, "assets"), { recursive: true });
  await writeFile(path.join(project.root, "assets", "tone.wav"), toneWav());
  const entryPath = path.join(project.root, "index.html");
  const entry = await readFile(entryPath, "utf8");
  await writeFile(entryPath, entry.replaceAll('data-duration="8"', 'data-duration="30"'));
  const scenePath = path.join(project.root, project.sceneSource);
  const source = await readFile(scenePath, "utf8");
  await writeFile(scenePath, source.replaceAll('data-duration="8"', 'data-duration="30"').replace(
    "  </div>\n</template>",
    '    <audio src="../assets/tone.wav" data-start="0" data-duration="30" preload="auto"></audio>\n  </div>\n</template>',
  ));
}

async function waitForActiveMedia(page: import("puppeteer-core").Page): Promise<{
  paused: boolean;
  muted: boolean;
  currentTime: number;
}> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const truth = await frame.evaluate(() => {
        const player = document.querySelector("hyperframes-player") as ({
          _parentMedia?: Array<{ el: HTMLMediaElement }>;
          currentTime?: number;
          muted?: boolean;
          paused?: boolean;
          _audioOwner?: "runtime" | "parent";
          iframeElement?: HTMLIFrameElement;
        } & HTMLElement) | null;
        const proxies = player?._parentMedia?.map(({ el }) => el) ?? [];
        const nested = player?.iframeElement?.contentDocument
          ? [...player.iframeElement.contentDocument.querySelectorAll<HTMLMediaElement>("audio,video")]
          : [];
        const authored = [...document.querySelectorAll<HTMLMediaElement>("audio,video"), ...nested];
        const proxy = proxies.find((element) => !element.paused && !element.muted && element.currentTime > 0.05);
        if (proxy) return { paused: false, muted: false, currentTime: proxy.currentTime };
        // Under runtime ownership the authored element is deliberately muted:
        // HyperFrames routes it through its runtime audio graph. The transport
        // owner, not that source-node flag, is the audible-output authority.
        const runtime = authored.find((element) => !element.paused && element.currentTime > 0.05);
        return player?._audioOwner === "runtime" && player.muted === false && player.paused === false && runtime
          ? { paused: false, muted: false, currentTime: runtime.currentTime }
          : null;
      }).catch(() => null);
      if (truth) return truth;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  const state = await Promise.all(page.frames().map(async (frame) => ({
    url: frame.url(),
    player: await frame.evaluate(() => {
      const player = document.querySelector("hyperframes-player") as (HTMLElement & {
        muted?: boolean; audioLocked?: boolean; paused?: boolean; currentTime?: number;
        _audioOwner?: string; _parentMedia?: Array<{ start: number; duration: number }>;
      }) | null;
      return player ? {
        muted: player.muted, audioLocked: player.audioLocked,
        paused: player.paused, currentTime: player.currentTime,
        audioOwner: player._audioOwner,
        proxyTiming: player._parentMedia?.map(({ start, duration }) => ({ start, duration })) ?? [],
      } : null;
    }).catch(() => null),
    media: await frame.evaluate(() => [...new Set([
      ...document.querySelectorAll<HTMLMediaElement>("audio,video"),
      ...((document.querySelector("hyperframes-player") as ({
        _parentMedia?: Array<{ el: HTMLMediaElement }>;
      } & HTMLElement) | null)?._parentMedia?.map(({ el }) => el) ?? []),
    ])]
      .map((element) => ({ paused: element.paused, muted: element.muted, currentTime: element.currentTime,
        readyState: element.readyState, src: element.currentSrc || element.getAttribute("src"), error: element.error?.message ?? null })))
      .catch(() => []),
  })));
  throw new Error(`no nested preview media became active and audible: ${JSON.stringify(state)}`);
}

describe("audible preview transport", () => {
  it("plays real nested media unmuted and advances only after the host acknowledges playback", async () => {
    await withStudioBrowser("preview-audio", async ({ page }) => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForSelector('[button], [data-timeline-viewport]', { timeout: 30_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="Play"]') as HTMLButtonElement | null;
        return button !== null && !button.disabled;
      }, { timeout: 20_000 });
      await page.evaluate(() => {
        const messages: unknown[] = [];
        Object.assign(window, { __vidcomBridgeMessages: messages });
        window.addEventListener("message", (event) => {
          if (event.data?.channel === "vidcom-preview") messages.push(event.data);
        });
      });
      await page.click('button[aria-label="Play"]');
      await page.waitForFunction(() => document.querySelector('button[aria-label="Pause"]') !== null, { timeout: 3_000 }).catch(async (cause) => {
        const state = await page.evaluate(() => ({
          text: document.body.innerText.slice(-700),
          play: document.querySelector('button[aria-label="Play"]') !== null,
          pause: document.querySelector('button[aria-label="Pause"]') !== null,
          messages: (window as unknown as { __vidcomBridgeMessages?: unknown[] }).__vidcomBridgeMessages,
        }));
        const frames = await Promise.all(page.frames().map(async (frame) => ({
          url: frame.url(),
          media: await frame.evaluate(() => ({
            enabled: [...document.querySelectorAll("button")].map((button) => button.textContent),
            played: ((window as unknown as { __vidcomPlayedMedia?: HTMLMediaElement[] }).__vidcomPlayedMedia ?? [])
              .map((element) => ({ paused: element.paused, muted: element.muted, currentTime: element.currentTime, error: element.error?.message ?? null })),
          })).catch(() => null),
        })));
        throw new Error(`preview did not acknowledge play: ${JSON.stringify({ state, frames })}`, { cause });
      });

      const truth = await waitForActiveMedia(page);
      expect(truth.paused).toBe(false);
      expect(truth.muted).toBe(false);
      expect(truth.currentTime).toBeGreaterThan(0);
    }, prepareToneProject);
  }, 60_000);

  it("keeps transport paused after autoplay denial and resumes from the preview-principal gesture", async () => {
    await withStudioBrowser("preview-audio-activation", async ({ page }) => {
      await page.evaluateOnNewDocument(() => {
        void customElements.whenDefined("hyperframes-player").then(() => {
          const Player = customElements.get("hyperframes-player");
          const prototype = Player?.prototype as { play?: (...args: unknown[]) => unknown; __vidcomWrappedPlay?: boolean } | undefined;
          if (!prototype?.play || prototype.__vidcomWrappedPlay) return;
          const original = prototype.play;
          prototype.__vidcomWrappedPlay = true;
          prototype.play = function play(...args: unknown[]) {
            const current = window as unknown as { __vidcomMediaActivated?: boolean };
            if (!current.__vidcomMediaActivated) {
              window.setTimeout(() => {
                (this as unknown as EventTarget).dispatchEvent(new CustomEvent("playbackerror", {
                  detail: { error: new DOMException("gesture required by test browser", "NotAllowedError") },
                }));
              }, 25);
              // A denied autoplay request never starts nested media. Calling the
              // original first made a busy runner play the whole clip before
              // the injected denial timer could fire.
              return undefined;
            }
            return original.apply(this, args);
          };
        });
        window.addEventListener("click", (event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('button[aria-label="Enable preview audio and resume playback"]')) {
            Object.assign(window, { __vidcomMediaActivated: true });
          }
        }, true);
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="Play"]') as HTMLButtonElement | null;
        return button !== null && !button.disabled;
      }, { timeout: 30_000 });
      await page.click('button[aria-label="Play"]');
      await page.waitForFunction(() => document.body.innerText.includes("Click Enable audio in the preview"),
        { timeout: 10_000, polling: 25 });
      expect(await page.$('button[aria-label="Pause"]')).toBeNull();

      const host = page.frames().find((frame) => frame.url().includes("/preview-host.html"));
      if (!host) throw new Error("trusted preview host frame was not found");
      const enable = await host.waitForSelector('button[aria-label="Enable preview audio and resume playback"]', {
        visible: true,
        timeout: 10_000,
      });
      await enable!.click();
      await page.waitForSelector('button[aria-label="Pause"]', { timeout: 10_000 });
      await waitForActiveMedia(page);
    }, prepareToneProject);
  }, 60_000);

  it("reports a media resource failure as paused and allows an explicit retry", async () => {
    await withStudioBrowser("preview-audio-resource-error", async ({ page }) => {
      await page.evaluateOnNewDocument(() => {
        void customElements.whenDefined("hyperframes-player").then(() => {
          const Player = customElements.get("hyperframes-player");
          const prototype = Player?.prototype as { play?: (...args: unknown[]) => unknown; __vidcomWrappedResourcePlay?: boolean } | undefined;
          if (!prototype?.play || prototype.__vidcomWrappedResourcePlay) return;
          const original = prototype.play;
          prototype.__vidcomWrappedResourcePlay = true;
          prototype.play = function play(...args: unknown[]) {
            const current = window as unknown as { __vidcomInjectedResourceError?: boolean };
            const result = original.apply(this, args);
            if (!current.__vidcomInjectedResourceError) {
              current.__vidcomInjectedResourceError = true;
              window.setTimeout(() => {
                (this as unknown as EventTarget).dispatchEvent(new CustomEvent("playbackerror", {
                  detail: { error: new Error("test media decode failed") },
                }));
              }, 25);
            }
            return result;
          };
        });
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="Play"]') as HTMLButtonElement | null;
        return button !== null && !button.disabled;
      }, { timeout: 30_000 });
      await page.click('button[aria-label="Play"]');
      await page.waitForFunction(() => document.body.innerText.includes("Fix the media or reload, then press Play."),
        { timeout: 10_000, polling: 25 });
      await page.waitForSelector('button[aria-label="Play"]', { timeout: 3_000 });
      await page.click('button[aria-label="Play"]');
      await page.waitForSelector('button[aria-label="Pause"]', { timeout: 10_000 });
      await waitForActiveMedia(page);
    }, prepareToneProject);
  }, 60_000);
});
