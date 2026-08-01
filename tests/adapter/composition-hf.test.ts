import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
    const document = await buildCompositionDocument(ref, DEFAULT_PREVIEW_SETTINGS, { root: true });
    expect(document).toContain('id="hf-preview-settings"');
    expect(document).toContain("/api/hf/runtime");
    expect(document.match(/id="hf-preview-settings"/g)).toHaveLength(1);
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

  it("maps an SDK rejection to the stable domain error", async () => {
    await expect(applyCompositionOps(ref, "index.html" as RelPath, [
      { kind: "setText", target: "missing", value: "No" },
    ])).resolves.toMatchObject({ ok: false, error: { code: ErrorCode.SdkRejected } });
  });
});
