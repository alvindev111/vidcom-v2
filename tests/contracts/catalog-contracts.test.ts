import { describe, expect, it } from "vitest";

import {
  CatalogInstallExecuteRequestSchema,
  CatalogInstallPrepareRequestSchema,
  CatalogInstallPrepareResponseSchema,
  CatalogItemDtoSchema,
  CatalogListQuerySchema,
  CatalogListResponseSchema,
} from "@vidcom/contracts";

const COMMIT = "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c";

const item = {
  name: "lower-third",
  kind: "block",
  title: "Lower third",
  description: null,
  tags: ["social"],
  category: "Social",
  version: `git:${COMMIT}`,
  integrity: null,
  materialization: "metadata",
  source: { registry: "hyperframes", revision: COMMIT, committedAt: "2026-08-10T10:00:00Z" },
  dependencies: [],
  compatibility: { aspectRatios: null, minWidth: 1920, fps: null, minHyperframesVersion: null },
  durationSeconds: 4,
  entry: "blocks/lower-third/index.html",
  previewPath: null,
  compatibilityWarning: null,
};

describe("shared catalog contracts", () => {
  it("accepts a metadata-only listing item and a verified one", () => {
    expect(CatalogItemDtoSchema.safeParse(item).success).toBe(true);
    expect(CatalogItemDtoSchema.safeParse({
      ...item,
      version: "1.0.0",
      integrity: { manifest: "a".repeat(64), files: { "templates/x/scene.html": "b".repeat(64) } },
      materialization: "verified",
      source: { registry: "bundled", revision: null, committedAt: null },
      previewPath: "templates/x/preview.svg",
      compatibilityWarning: { status: "incompatible", required: "0.8.0", runtime: "0.7.86" },
    }).success).toBe(true);
  });

  it("never exposes a local source path or an absolute registry URL to the client", () => {
    expect(CatalogItemDtoSchema.safeParse({ ...item, sourcePath: "/app/cache/x" }).success).toBe(false);
    expect(CatalogItemDtoSchema.safeParse({
      ...item,
      source: { registry: "hyperframes", revision: COMMIT, committedAt: null, url: "https://x/y" },
    }).success).toBe(false);
  });

  it("requires the listing envelope to state its source and staleness", () => {
    const listing = { items: [item], source: "cache", stale: true };
    expect(CatalogListResponseSchema.safeParse(listing).success).toBe(true);
    expect(CatalogListResponseSchema.safeParse({ ...listing, source: "disk" }).success).toBe(false);
    expect(CatalogListResponseSchema.safeParse({ items: [item], source: "cache" }).success).toBe(false);
  });

  it("filters by kind first, then category, tags and a bounded query", () => {
    expect(CatalogListQuerySchema.safeParse({}).success).toBe(true);
    expect(CatalogListQuerySchema.safeParse({ kind: "template", query: "map" }).success).toBe(true);
    expect(CatalogListQuerySchema.safeParse({ kind: "example" }).success).toBe(false);
    expect(CatalogListQuerySchema.safeParse({ query: "x".repeat(129) }).success).toBe(false);
    expect(CatalogListQuerySchema.safeParse({ tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }).success)
      .toBe(false);
  });

  it("binds an install intent to one exact mount and refuses a client-chosen digest", () => {
    const prepare = {
      name: "lower-third",
      version: `git:${COMMIT}`,
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 4,
    };
    expect(CatalogInstallPrepareRequestSchema.safeParse(prepare).success).toBe(true);
    expect(CatalogInstallPrepareRequestSchema.safeParse({
      ...prepare,
      existingPolicy: "reuse",
    }).success).toBe(true);
    expect(CatalogInstallPrepareRequestSchema.safeParse({
      ...prepare,
      mount: { kind: "into-scene", sceneId: "scene-2" },
    }).success).toBe(true);
    // No client-supplied integrity, files or plan: the server recomputes all of it.
    expect(CatalogInstallPrepareRequestSchema.safeParse({ ...prepare, integrity: "a".repeat(64) }).success)
      .toBe(false);
    expect(CatalogInstallPrepareRequestSchema.safeParse({ ...prepare, mount: { kind: "root" } }).success)
      .toBe(false);
    expect(CatalogInstallPrepareRequestSchema.safeParse({ ...prepare, existingPolicy: "force" }).success)
      .toBe(false);
    expect(CatalogInstallExecuteRequestSchema.safeParse({ ...prepare, grantId: "grant_1" }).success).toBe(true);
    expect(CatalogInstallExecuteRequestSchema.safeParse(prepare).success).toBe(false);
  });

  it("models all three prepare outcomes without inventing an unmanaged version", () => {
    expect(CatalogInstallPrepareResponseSchema.safeParse({ status: "skipped" }).success).toBe(true);
    expect(CatalogInstallPrepareResponseSchema.safeParse({
      status: "choice_required",
      comparison: "unmanaged",
      choices: ["replace", "skip"],
      existing: { version: null, integrity: null, targetHashes: { "blocks/x/index.html": `sha256:${"a".repeat(64)}` } },
      candidate: { version: "1.0.0", integrity: "b".repeat(64) },
    }).success).toBe(true);
    expect(CatalogInstallPrepareResponseSchema.safeParse({
      status: "ready",
      grantId: "grant_1",
      plan: {
        files: [{ path: "blocks/x/index.html", action: "create", fromHash: null, toDigest: "a".repeat(64) }],
        directories: ["blocks", "blocks/x"],
        mountTarget: "blocks/x/index.html",
        expectedRevision: 4,
        targetHashes: { "index.html": `sha256:${"c".repeat(64)}` },
        planDigest: `sha256:${"d".repeat(64)}`,
      },
    }).success).toBe(true);
    expect(CatalogInstallPrepareResponseSchema.safeParse({
      status: "choice_required",
      comparison: "sideways",
      choices: ["replace"],
      existing: { version: null, integrity: null, targetHashes: {} },
      candidate: { version: "1.0.0", integrity: "b".repeat(64) },
    }).success).toBe(false);
  });
});
