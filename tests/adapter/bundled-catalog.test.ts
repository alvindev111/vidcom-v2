import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_CATALOG_MANIFEST_FILE,
  catalogManifestDigest,
  loadBundledCatalog,
  resolveRuntimePaths,
} from "@vidcom/adapter";
import { isVerifiedCatalogItem } from "@vidcom/core";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryCatalog(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vidcom-bundled-catalog-"));
  roots.push(root);
  return root;
}

describe("frozen bundled catalog snapshot", () => {
  it("loads the shipped snapshot as verified items with matching digests", async () => {
    const paths = resolveRuntimePaths({ mode: "development", appDataRoot: path.resolve("/app-data") });
    const catalog = await loadBundledCatalog(paths.catalogAssetRoot);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(catalog.value.items.length).toBeGreaterThan(0);
    for (const item of catalog.value.items) {
      expect(isVerifiedCatalogItem(item)).toBe(true);
      expect(item.source).toEqual({
        registry: "bundled",
        url: null,
        revision: null,
        committedAt: null,
      });
      // Every declared file exists with the declared digest, and the manifest
      // digest covers the displayed metadata as well as the bytes.
      expect(item.integrity?.manifest).toBe(catalogManifestDigest(item));
      expect(Object.keys(item.integrity?.files ?? {})).toContain(item.entry);
    }
    expect(catalog.value.items.some((item) => item.kind === "template")).toBe(true);
  });

  it("rejects a snapshot whose bytes drift from the declared digest", async () => {
    const root = await temporaryCatalog();
    await mkdir(path.join(root, "files", "templates", "drift"), { recursive: true });
    await writeFile(path.join(root, "files", "templates", "drift", "scene.html"), "<section></section>\n", "utf8");
    await writeFile(
      path.join(root, BUNDLED_CATALOG_MANIFEST_FILE),
      JSON.stringify({
        schemaVersion: 1,
        items: [{
          name: "drift",
          kind: "template",
          title: "Drift",
          description: null,
          category: "Openers",
          tags: [],
          version: "1.0.0",
          entry: "templates/drift/scene.html",
          durationSeconds: null,
          compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
          preview: null,
          dependencies: [],
          upstream: null,
          integrity: {
            algo: "sha256",
            files: { "templates/drift/scene.html": "0".repeat(64) },
            manifest: "0".repeat(64),
          },
        }],
      }),
      "utf8",
    );
    const catalog = await loadBundledCatalog(root);
    expect(catalog).toEqual({ ok: false, error: { code: "integrity_mismatch", name: "drift" } });
  });

  it("fails closed when the snapshot is absent instead of returning an empty catalog", async () => {
    const root = await temporaryCatalog();
    expect(await loadBundledCatalog(path.join(root, "missing")))
      .toEqual({ ok: false, error: { code: "manifest_unreadable", name: null } });
  });
});
