import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

import {
  buildCaptionRuntimeScript,
  injectPreviewSettingsDocument,
} from "@vidcom/adapter";
import { DEFAULT_PREVIEW_SETTINGS } from "@vidcom/core";

const BASE_HTML = `<!doctype html><html><head></head><body>
  <div data-composition-src="scene.html" data-start="6">
    <p class="caption"><span class="w" data-start="0.5" data-end="0.8">bốn</span></p>
  </div>
</body></html>`;

function executeRuntime(script: string) {
  const source = script.replace(/^<script\b[^>]*>/u, "").replace(/<\/script>$/u, "");
  const { window, document } = parseHTML(BASE_HTML);
  const forwarded: unknown[] = [];
  window.parent = {
    postMessage: (message: unknown) => { forwarded.push(message); },
  } as unknown as Window;
  Function("window", "document", source)(window, document);
  return { document, post: window.parent.postMessage, forwarded };
}

describe("caption runtime", () => {
  it("uses rational runtime fps and subtracts the owning layer start", () => {
    const runtime = executeRuntime(buildCaptionRuntimeScript());
    const word = runtime.document.querySelector(".caption .w");

    runtime.post({
      source: "hf-preview",
      type: "timeline",
      fps: { numerator: 30_000, denominator: 1_001 },
    });
    runtime.post({ source: "hf-preview", type: "state", frame: (6.6 * 30_000) / 1_001 });
    expect(word?.classList.contains("active")).toBe(true);

    runtime.post({ source: "hf-preview", type: "state", frame: (6.9 * 30_000) / 1_001 });
    expect(word?.classList.contains("active")).toBe(false);
    expect(runtime.forwarded).toHaveLength(3);
  });

  it("injects one shared runtime and active color only into root documents", () => {
    const settings = {
      ...DEFAULT_PREVIEW_SETTINGS,
      subtitles: { ...DEFAULT_PREVIEW_SETTINGS.subtitles, activeColor: "#12AB34" },
    };
    const root = injectPreviewSettingsDocument(BASE_HTML, settings, {
      root: true,
      fileBaseUrl: "/files/",
    });
    const nested = injectPreviewSettingsDocument(BASE_HTML, settings, {
      root: false,
      fileBaseUrl: "/files/",
    });

    expect(root.match(/id="vidcom-caption-runtime"/gu)).toHaveLength(1);
    expect(root).toContain("--subtitle-active-color: #12AB34");
    expect(nested).not.toContain('id="vidcom-caption-runtime"');
  });
});
