import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";

import { ErrorCode, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  applyCompositionOps,
  buildCompositionDocument,
  compositionRoot,
  readSceneElements,
} from "@vidcom/adapter";
import { DEFAULT_PREVIEW_SETTINGS, type AbsolutePath, type ProjectRef } from "@vidcom/core";

let root: string;
let ref: ProjectRef;
const source = `<!doctype html><html><head></head><body>
<main data-hf-id="hf-root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="4">
  <h1 data-hf-id="hf-title">Old title</h1>
</main></body></html>`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vidcom-composition-hf-"));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "hyperframes.json"), "{}\n");
  await writeFile(path.join(root, "vidcom.json"), '{"id":"project_hf"}\n');
  await writeFile(path.join(root, "index.html"), source);
  ref = {
    id: "project_hf" as ProjectId,
    slug: "project-hf",
    root: root as AbsolutePath,
    entry: "index.html" as RelPath,
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CompositionHf", () => {
  it("does not let a nested template replace the authored document root", () => {
    const parsed = compositionRoot(`<html><body>
      <main data-composition-id="root"><template><div data-composition-id="evil"></div></template></main>
    </body></html>`);
    expect((parsed as Element).tagName).toBe("BODY");
    expect(parsed.querySelector('[data-composition-id="root"]')).not.toBeNull();
  });

  it("uses a structural DOM path for an element without an authored id", () => {
    const parsed = readSceneElements(
      compositionRoot('<html><body><div data-composition-id="root"><span data-start="1" data-duration="2">x</span></div></body></html>'),
      "root",
    );
    expect(parsed.elements[0]?.id).toBe("div:nth-child(1)>span:nth-child(1)");
    expect(parsed.elements[0]?.id).not.toMatch(/^span:\d+$/);
  });

  it("builds the only preview representation with runtime and settings", async () => {
    const document = await buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, {
      mode: "preview",
      root: true,
      projectRevision: 12,
      changeSeq: 34,
    });
    expect(document).toContain('id="hf-preview-settings"');
    expect(document).toContain("/api/hf/runtime");
    expect(document.match(/id="hf-preview-settings"/g)).toHaveLength(1);
    expect(document).toMatch(/<head[^>]*>\s*<meta data-vidcom-preview-security="csp"[^>]*>\s*<script data-vidcom-health="collector"/u);
    expect(document).toContain('data-project-revision="12"');
    expect(document).toContain('data-change-seq="34"');
    expect(document.indexOf('data-vidcom-health="collector"')).toBeLessThan(document.indexOf("Old title"));
  });

  it("localizes the upstream GSAP compatibility tag on preview only", async () => {
    const document = await buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, {
      mode: "preview",
      root: true,
      projectRevision: 1,
      changeSeq: 1,
      runtimeUrl: "/api/preview/v1/c/token/projects/project_hf/runtime",
      fileBaseUrl: "/api/preview/v1/c/token/projects/project_hf/assets/",
    });
    expect(document).toContain("/api/preview/v1/c/token/projects/project_hf/vendor/gsap.js");
    expect(document).not.toContain("cdn.jsdelivr.net/npm/gsap");
  });

  it("keeps the preview health collector out of render documents", async () => {
    const document = await buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, {
      mode: "render",
      root: true,
    });
    expect(document).not.toContain("data-vidcom-health");
    expect(document).not.toContain("__vidcomHealth");
  });

  it("makes preview identity required and forbidden for render at compile time", () => {
    if (false) {
      // @ts-expect-error preview documents require both durable identity fields
      void buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, { mode: "preview", root: true });
      // @ts-expect-error render documents cannot carry preview identity
      void buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, {
        mode: "render",
        root: true,
        projectRevision: 1,
        changeSeq: 1,
      });
    }
    expect(true).toBe(true);
  });

  it("applies SDK operations in memory without writing the project", async () => {
    const result = await applyCompositionOps(ref, "index.html" as RelPath, [
      { kind: "setText", target: "hf-title", value: "New title" },
      { kind: "setTiming", target: "hf-root", value: { duration: 7 } },
    ]);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value).toContain("New title");
      expect(result.value).toContain('data-duration="7"');
    }
    expect(await readFile(path.join(root, "index.html"), "utf8")).toBe(source);
  });

  it("serializes an owned layout offset without overwriting authored transform motion", async () => {
    const authored = source.replace(
      '<h1 data-hf-id="hf-title">',
      '<h1 data-hf-id="hf-title" style="color: red; transform: scale(1.2)">',
    );
    await writeFile(path.join(root, "index.html"), authored);
    const moved = await applyCompositionOps(ref, "index.html" as RelPath, [{
      kind: "setLayoutOffset", target: "hf-title", value: { x: 120, y: -24 },
    }]);
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;
    const node = parseHTML(moved.value).document.querySelector('[data-hf-id="hf-title"]');
    expect(node?.hasAttribute("data-vidcom-layout-offset")).toBe(true);
    expect(node?.getAttribute("style")).toContain("color: red");
    expect(node?.getAttribute("style")).toContain("transform: scale(1.2)");
    expect(node?.getAttribute("style")).toContain("--vidcom-layout-x: 120px");
    expect(node?.getAttribute("style")).toContain("--vidcom-layout-y: -24px");
    expect(await readFile(path.join(root, "index.html"), "utf8")).toBe(authored);

    await writeFile(path.join(root, "index.html"), moved.value);
    const reset = await applyCompositionOps(ref, "index.html" as RelPath, [{
      kind: "setLayoutOffset", target: "hf-title", value: { x: 0, y: 0 },
    }]);
    if (!reset.ok) throw new Error(JSON.stringify(reset.error));
    const resetNode = parseHTML(reset.value).document.querySelector('[data-hf-id="hf-title"]');
    expect(resetNode?.hasAttribute("data-vidcom-layout-offset")).toBe(false);
    expect(resetNode?.getAttribute("style")).toContain("color: red");
    expect(resetNode?.getAttribute("style")).toContain("transform: scale(1.2)");
    expect(resetNode?.getAttribute("style")).not.toContain("--vidcom-layout-");
  });

  it("locks authored translate until VidCom owns the layout offset", async () => {
    await writeFile(path.join(root, "index.html"), source.replace(
      '<h1 data-hf-id="hf-title">',
      '<h1 data-hf-id="hf-title" style="translate: 10px 20px">',
    ));
    await expect(applyCompositionOps(ref, "index.html" as RelPath, [{
      kind: "setLayoutOffset", target: "hf-title", value: { x: 5, y: 6 },
    }])).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.SdkRejected } });
  });

  it("injects the shared layout-offset rule into preview and render documents", async () => {
    const [preview, render] = await Promise.all([
      buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, {
        mode: "preview", root: true, projectRevision: 1, changeSeq: 1,
      }),
      buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, { mode: "render", root: true }),
    ]);
    for (const document of [preview, render]) {
      expect(document).toContain("[data-vidcom-layout-offset]");
      expect(document).toContain("translate: var(--vidcom-layout-x, 0px) var(--vidcom-layout-y, 0px)");
    }
  });

  it("maps an SDK rejection to the stable domain error", async () => {
    await expect(applyCompositionOps(ref, "index.html" as RelPath, [
      { kind: "setText", target: "missing", value: "No" },
    ])).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.SdkRejected } });
  });
});
