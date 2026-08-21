// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DomSvgSanitizer } from "@vidcom/adapter";
import { ErrorCode, type ContentHash } from "@vidcom/contracts";
import type { AbsolutePath, StagedFileSource } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function staged(content: string | Uint8Array): Promise<StagedFileSource> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-svg-sanitize-"));
  roots.push(root);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const sourcePath = path.join(root, "source.svg");
  await writeFile(sourcePath, bytes);
  return {
    sourcePath: sourcePath as AbsolutePath,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as ContentHash,
  };
}

describe("DOM SVG sanitizer", () => {
  it("removes active nodes, event handlers, imports and every non-fragment URL", async () => {
    const source = await staged(`<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://bad.test/" onload="evil()"
      style="background:image-set('https://bad.test/a.png')">
      <style>@import "https://bad.test/x.css"; .safe { fill: url(#gradient); color: red }
        .bad { background: url(data:image/png;base64,AAAA) }</style>
      <defs><linearGradient id="gradient"/></defs>
      <script>alert(1)</script><foreignObject><div>bad</div></foreignObject><iframe/><object/><embed/>
      <a href="https://bad.test"><rect id="external" fill="url(https://bad.test/a)"/></a>
      <use href="#external" style="fill:url(#gradient);background:url(javascript:evil)"/>
    </svg>`);

    const result = await new DomSvgSanitizer().sanitize(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toMatch(/script|foreignObject|iframe|object|embed|onload|@import|bad\.test|data:|javascript:/u);
    expect(result.value).toContain('href="#external"');
    expect(result.value).toContain("url(#gradient)");

    const second = await new DomSvgSanitizer().sanitize(await staged(result.value));
    expect(second).toEqual({ ok: true, value: result.value });
  });

  it.each([
    `<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg>&xxe;</svg>`,
    `<html><body>not svg</body></html>`,
    `<svg><g></svg>`,
  ])("rejects unsafe or malformed SVG before publication", async (content) => {
    await expect(new DomSvgSanitizer().sanitize(await staged(content))).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCode.UnsupportedMedia },
    });
  });

  it("rejects invalid UTF-8", async () => {
    await expect(new DomSvgSanitizer().sanitize(await staged(Uint8Array.from([0xff, 0xfe, 0xfd]))))
      .resolves.toMatchObject({ ok: false, error: { code: ErrorCode.UnsupportedMedia } });
  });
});
