import { describe, expect, it } from "vitest";

import {
  catalogChoicePrompt,
  catalogEmptyState,
  catalogInstallRequest,
  catalogItemBadges,
  catalogListPath,
  catalogInstallFailureMessage,
  catalogMountOptions,
  type CatalogRailFilter,
} from "@/lib/studio/catalog-rail";
import type { CatalogItemDto, CatalogListResponse } from "@vidcom/contracts";

const COMMIT = "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c";
const MANIFEST = "c".repeat(64);

function item(overrides: Partial<CatalogItemDto> = {}): CatalogItemDto {
  return {
    name: "lower-third",
    kind: "block",
    title: "Lower third",
    description: "Animated lower third",
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
    ...overrides,
  } as CatalogItemDto;
}

const filter = (overrides: Partial<CatalogRailFilter> = {}): CatalogRailFilter => ({
  kind: "all",
  tags: [],
  query: "",
  category: null,
  ...overrides,
});

describe("catalog rail view model", () => {
  it("builds a listing path from the filter, kind first", () => {
    expect(catalogListPath(filter())).toBe("/api/v1/catalog");
    expect(catalogListPath(filter({ kind: "template" }))).toBe("/api/v1/catalog?kind=template");
    expect(catalogListPath(filter({ kind: "block", tags: ["social", "text"], query: "wipe left" })))
      .toBe("/api/v1/catalog?kind=block&tags=social%2Ctext&q=wipe+left");
    expect(catalogListPath(filter({ category: "Openers" }))).toBe("/api/v1/catalog?category=Openers");
  });

  it("targets the two install phases with the exact intent and the path grant", () => {
    const intent = {
      name: "lower-third",
      version: `git:${COMMIT}`,
      mount: { kind: "new-scene" as const, toIndex: 2 },
      expectedRevision: 7,
    };
    const prepared = catalogInstallRequest("project_x", intent);
    expect(prepared.path).toBe("/api/v1/projects/project_x/catalog-items/plans");
    expect(prepared.init.method).toBe("POST");
    expect(JSON.parse(String(prepared.init.body))).toEqual(intent);

    const executed = catalogInstallRequest("project_x", { ...intent, existingPolicy: "replace" }, "grant_1");
    expect(executed.path).toBe("/api/v1/projects/project_x/catalog-items/plans/grant_1");
    // The grant travels in the path; the body repeats the identical intent.
    expect(JSON.parse(String(executed.init.body))).toEqual({ ...intent, existingPolicy: "replace" });
  });

  it("shows provenance, staleness and how far verification has got", () => {
    const network = catalogItemBadges(item(), { source: "network", stale: false });
    expect(network).toMatchObject({
      source: "network",
      stale: false,
      version: `git:${COMMIT}`,
      shortVersion: `git:${COMMIT.slice(0, 7)}`,
      verification: "on-install",
      digest: null,
    });
    expect(network.verificationLabel).toMatch(/verified when you install/iu);

    const cached = catalogItemBadges(item(), { source: "cache", stale: true });
    expect(cached).toMatchObject({ source: "cache", stale: true });
    expect(cached.staleLabel).toMatch(/older copy/iu);

    const verified = catalogItemBadges(item({
      version: "1.2.0",
      materialization: "verified",
      integrity: { manifest: MANIFEST, files: { "templates/x/scene.html": "a".repeat(64) } },
      source: { registry: "bundled", revision: null, committedAt: null },
    }), { source: "bundled", stale: false });
    expect(verified).toMatchObject({
      source: "bundled",
      verification: "verified",
      digest: MANIFEST,
      shortDigest: MANIFEST.slice(0, 12),
      shortVersion: "1.2.0",
    });
  });

  it("carries a compatibility warning as its own visible state", () => {
    expect(catalogItemBadges(item({
      compatibilityWarning: { status: "incompatible", required: "0.8.0", runtime: "0.7.86" },
    }), { source: "network", stale: false }).compatibility).toEqual({
      level: "blocked",
      message: "Needs HyperFrames 0.8.0; this build ships 0.7.86.",
    });
    expect(catalogItemBadges(item({
      compatibilityWarning: { status: "unknown", required: "^0.8" },
    }), { source: "network", stale: false }).compatibility).toEqual({
      level: "unknown",
      message: "Requires HyperFrames ^0.8, which cannot be checked.",
    });
    expect(catalogItemBadges(item(), { source: "network", stale: false }).compatibility).toBeNull();
  });

  it("explains an empty rail by its actual reason", () => {
    const empty = (listing: Partial<CatalogListResponse>, applied = filter()) =>
      catalogEmptyState({ items: [], source: "network", stale: false, ...listing }, applied);
    expect(empty({})).toMatchObject({ reason: "no-results" });
    expect(empty({ source: "bundled" })?.message).toMatch(/offline/iu);
    expect(empty({}, filter({ query: "zzz" }))?.message).toMatch(/zzz/u);
    expect(empty({}, filter({ kind: "template" }))?.message).toMatch(/template/iu);
    expect(catalogEmptyState({ items: [item()], source: "network", stale: false }, filter())).toBeNull();
  });

  it("asks the exact question the server allows, with no invented version", () => {
    const identical = catalogChoicePrompt({
      status: "choice_required",
      comparison: "identical",
      choices: ["reuse", "skip"],
      existing: { version: "1.2.0", integrity: MANIFEST, targetHashes: {} },
      candidate: { version: "1.2.0", integrity: MANIFEST },
    });
    expect(identical.actions.map((action) => action.policy)).toEqual(["reuse", "skip"]);
    expect(identical.actions[0]!.label).toBe("Reuse & mount");
    expect(identical.description).toMatch(/already installed/iu);

    const newer = catalogChoicePrompt({
      status: "choice_required",
      comparison: "newer",
      choices: ["replace", "skip"],
      existing: { version: "1.0.0", integrity: "e".repeat(64), targetHashes: {} },
      candidate: { version: "1.2.0", integrity: MANIFEST },
    });
    expect(newer.actions.map((action) => action.policy)).toEqual(["replace", "skip"]);
    expect(newer.description).toContain("1.0.0");
    expect(newer.description).toContain("1.2.0");

    const unmanaged = catalogChoicePrompt({
      status: "choice_required",
      comparison: "unmanaged",
      choices: ["replace", "skip"],
      existing: { version: null, integrity: null, targetHashes: { "blocks/x/index.html": `sha256:${"a".repeat(64)}` } },
      candidate: { version: "1.2.0", integrity: MANIFEST },
    });
    expect(unmanaged.actions.map((action) => action.policy)).toEqual(["replace", "skip"]);
    expect(unmanaged.description).toMatch(/no install record/iu);
    // Nothing may imply a version for a file the app did not install.
    expect(unmanaged.description).not.toContain("null");
    expect(unmanaged.existingVersionLabel).toBe("unknown");
    expect(unmanaged.existingDigestLabel).toBe("unknown");
    expect(unmanaged.candidateDigestLabel).toBe(MANIFEST.slice(0, 12));
    // Both versions and both digests are visible for a real version difference.
    expect(newer.existingDigestLabel).toBe("e".repeat(12));
    expect(newer.description).toContain("e".repeat(12));
    expect(newer.description).toContain(MANIFEST.slice(0, 12));
  });

  it("offers only the mounts the item kind supports", () => {
    const template = item({ kind: "template" });
    expect(catalogMountOptions(template, { sceneCount: 3, selectedSceneId: "scene-2" }))
      .toEqual([{ label: "Add as scene", mount: { kind: "new-scene", toIndex: 3 } }]);
    expect(catalogMountOptions(item(), { sceneCount: 3, selectedSceneId: null }))
      .toEqual([{ label: "Add as scene", mount: { kind: "new-scene", toIndex: 3 } }]);
    expect(catalogMountOptions(item(), { sceneCount: 3, selectedSceneId: "scene-2" })).toEqual([
      { label: "Add as scene", mount: { kind: "new-scene", toIndex: 3 } },
      { label: "Add into scene", mount: { kind: "into-scene", sceneId: "scene-2" } },
    ]);
  });

  it("keeps an integrity failure distinct from being offline", () => {
    expect(catalogInstallFailureMessage({ code: "integrity_mismatch", message: "digest mismatch" }))
      .toMatch(/does not match its digest/iu);
    expect(catalogInstallFailureMessage({ code: "integrity_mismatch", message: "digest mismatch" }))
      .not.toMatch(/offline/iu);
    expect(catalogInstallFailureMessage({ code: "download_unavailable", message: "offline" }))
      .toMatch(/could not be downloaded/iu);
    expect(catalogInstallFailureMessage({ code: "too_large", message: "big" })).toMatch(/too large/iu);
    expect(catalogInstallFailureMessage({ code: "write_conflict", message: "changed" }))
      .toMatch(/changed/iu);
    expect(catalogInstallFailureMessage({ code: "unknown_code", message: "boom" })).toBe("boom");
  });
});
