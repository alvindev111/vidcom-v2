import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FontkitCompatibilityInspector } from "@vidcom/adapter";
import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { FontCompatibilityService } from "@vidcom/core";
import type { AbsolutePath, CompositionSource, ProjectRef } from "@vidcom/core";

const roots: string[] = [];
const source = (byteSize: number): CompositionSource => ({
  path: "index.html" as RelPath,
  contentHash: `sha256:${"0".repeat(64)}` as ContentHash,
  byteSize,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function latinFontFixture(): Promise<string | null> {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Verdana.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the small cross-platform fixture allowlist.
    }
  }
  return null;
}

async function cjkFontFixture(): Promise<string | null> {
  const candidates = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:\\Windows\\Fonts\\msyh.ttc",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the small cross-platform fixture allowlist.
    }
  }
  return null;
}

async function projectFixture(html: string) {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-font-compatibility-"));
  roots.push(root);
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), html);
  const ref: ProjectRef = {
    id: "project_font_compatibility" as ProjectId,
    slug: "font-compatibility",
    root: root as AbsolutePath,
    entry: "index.html" as RelPath,
  };
  return { root, ref };
}

function composition(text: string, fontFamily = '"Verified Latin", sans-serif'): string {
  return `<!doctype html><html><head><meta charset="UTF-8"><style>
    @font-face { font-family: "Verified Latin"; src: url("./assets/verified.ttf"); }
    body { font-family: ${fontFamily}; }
  </style></head><body><main data-composition-id="root" data-duration="1"><p>${text}</p></main></body></html>`;
}

function fallbackComposition(text: string): string {
  return `<!doctype html><html><head><meta charset="UTF-8"><style>
    @font-face { font-family: "Verified Latin"; src: url("./assets/verified.ttf"); }
    @font-face { font-family: "Verified CJK"; src: url("./assets/verified-cjk.ttc"); }
    body { font-family: "Verified Latin", "Verified CJK", sans-serif; }
  </style></head><body><main data-composition-id="root" data-duration="1"><p>${text}</p></main></body></html>`;
}

describe("font compatibility with real files", () => {
  it("accepts Vietnamese glyphs and reports Japanese, Korean, and Chinese glyphs missing from a Latin font", async (context) => {
    const font = await latinFontFixture();
    if (!font) return context.skip("no known Latin system font is installed");
    const html = composition("Tiếng Việt đẹp");
    const value = await projectFixture(html);
    await copyFile(font, path.join(value.root, "assets/verified.ttf"));
    const inspector = new FontkitCompatibilityInspector();

    await expect(inspector.inspect(value.ref, [source(Buffer.byteLength(html))])).resolves.toEqual([]);

    const multilingual = composition("日本語 한국어 中文");
    await writeFile(path.join(value.root, "index.html"), multilingual);
    const issues = await inspector.inspect(value.ref, [source(Buffer.byteLength(multilingual))]);
    const missing = issues.find(({ kind }) => kind === "font-glyph-missing");
    expect(missing).toMatchObject({ fontFamily: "Verified Latin", fontFile: "assets/verified.ttf" });
    expect(missing?.missingCodePoints).toEqual(expect.arrayContaining([
      "日".codePointAt(0),
      "한".codePointAt(0),
      "中".codePointAt(0),
    ]));
    const diagnostics = await new FontCompatibilityService(inspector)
      .inspect(value.ref, [source(Buffer.byteLength(multilingual))]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      severity: "error",
      code: "font-glyph-missing",
      details: expect.objectContaining({
        missingCodePoints: expect.arrayContaining(["U+65E5", "U+D55C", "U+4E2D"]),
      }),
    }));

    const cjkFont = await cjkFontFixture();
    if (cjkFont) {
      await copyFile(cjkFont, path.join(value.root, "assets/verified-cjk.ttc"));
      const fallback = fallbackComposition("中文");
      await writeFile(path.join(value.root, "index.html"), fallback);
      await expect(inspector.inspect(value.ref, [source(Buffer.byteLength(fallback))])).resolves.toEqual([]);
    }
  });

  it("distinguishes malformed UTF-8 from unverified machine-dependent font fallback", async () => {
    const value = await projectFixture(composition("日本語", "system-ui, sans-serif"));
    const inspector = new FontkitCompatibilityInspector();
    await expect(inspector.inspect(value.ref, [source(1)])).resolves.toContainEqual(expect.objectContaining({
      kind: "font-coverage-unverified",
      sourceFile: "index.html",
      fontFamily: "system-ui",
    }));

    await writeFile(path.join(value.root, "index.html"), new Uint8Array([0xc3, 0x28]));
    await expect(inspector.inspect(value.ref, [source(2)])).resolves.toEqual([{
      kind: "invalid-utf8",
      sourceFile: "index.html",
    }]);
  });
});
