import { describe, expect, it } from "vitest";

import { type RelPath } from "@vidcom/contracts";
import {
  CATALOG_METADATA_LIMITS,
  CATALOG_NAME_PATTERN,
  HYPERFRAMES_EXPECTED_VERSION,
  assessCatalogRuntimeCompatibility,
  classifyCatalogVersion,
  isVerifiedCatalogItem,
  orderCatalogDependencyClosure,
  parseCatalogVersion,
  validateCatalogItem,
  type CatalogItem,
} from "@vidcom/core";

const COMMIT = "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c";
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function bundled(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    name: "title-card",
    kind: "template",
    title: "Title card",
    description: null,
    tags: ["intro", "text"],
    category: "Openers",
    version: "1.2.0",
    integrity: {
      algo: "sha256",
      files: { ["templates/title-card/scene.html" as RelPath]: "a".repeat(64) },
      manifest: "b".repeat(64),
    },
    materialization: "verified",
    source: { registry: "bundled", url: null, revision: null, committedAt: null },
    dependencies: [],
    compatibility: {
      aspectRatios: null,
      minWidth: null,
      fps: null,
      minHyperframesVersion: null,
    },
    durationSeconds: 4,
    entry: "templates/title-card/scene.html" as RelPath,
    preview: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return bundled({
    name: "lower-third",
    kind: "block",
    version: `git:${COMMIT}`,
    integrity: null,
    materialization: "metadata",
    source: {
      registry: "hyperframes",
      url: `https://raw.githubusercontent.com/heygen-com/hyperframes/${COMMIT}/registry/lower-third.json`,
      revision: COMMIT,
      committedAt: "2026-08-10T10:00:00Z",
    },
    entry: "blocks/lower-third/index.html" as RelPath,
    ...overrides,
  });
}

describe("catalog contract, version identity and materialization state", () => {
  it("accepts bundled semver and pinned git versions and rejects every other shape", () => {
    expect(parseCatalogVersion("1.2.0")).toEqual({ kind: "semver", value: "1.2.0" });
    expect(parseCatalogVersion("1.2.0-rc.1")).toEqual({ kind: "semver", value: "1.2.0-rc.1" });
    expect(parseCatalogVersion(`git:${COMMIT}`)).toEqual({ kind: "git", commit: COMMIT });
    for (const invalid of [
      "git:main",
      `git:${COMMIT.toUpperCase()}`,
      `git:${COMMIT.slice(0, 39)}`,
      `git:${COMMIT}a`,
      "v1.2.0",
      "1.2",
      "",
      " 1.2.0",
    ]) expect(parseCatalogVersion(invalid), invalid).toBeNull();
  });

  it("classifies reinstall candidates by semver, then by commit time, and never guesses newer", () => {
    const at = (committedAt: string | null, version: string) => ({ version, committedAt });
    expect(classifyCatalogVersion(at(null, "1.2.0"), at(null, "1.2.0"))).toBe("identical");
    expect(classifyCatalogVersion(at(null, "1.2.0"), at(null, "1.10.0"))).toBe("newer");
    expect(classifyCatalogVersion(at(null, "1.10.0"), at(null, "1.2.0"))).toBe("older");
    expect(classifyCatalogVersion(at(null, "1.2.0-rc.1"), at(null, "1.2.0"))).toBe("newer");
    const older = at("2026-08-10T10:00:00Z", `git:${COMMIT}`);
    const newer = at("2026-08-11T10:00:00Z", `git:${OTHER_COMMIT}`);
    expect(classifyCatalogVersion(older, newer)).toBe("newer");
    expect(classifyCatalogVersion(newer, older)).toBe("older");
    expect(classifyCatalogVersion(older, at("2026-08-10T10:00:00Z", `git:${OTHER_COMMIT}`)))
      .toBe("different");
    expect(classifyCatalogVersion(older, at(null, `git:${OTHER_COMMIT}`))).toBe("different");
    expect(classifyCatalogVersion(at(null, "1.2.0"), newer)).toBe("different");
    expect(classifyCatalogVersion(at(null, "not-a-version"), at(null, "1.2.0"))).toBe("different");
  });

  it("binds materialization state to integrity and exposes verified packages only", () => {
    expect(isVerifiedCatalogItem(bundled())).toBe(true);
    expect(isVerifiedCatalogItem(snapshot())).toBe(false);
    expect(validateCatalogItem(bundled())).toEqual([]);
    expect(validateCatalogItem(snapshot())).toEqual([]);
    expect(validateCatalogItem(bundled({ integrity: null }))).toContain("integrity_required");
    expect(validateCatalogItem(snapshot({ materialization: "verified" })))
      .toContain("integrity_required");
    expect(validateCatalogItem(bundled({ materialization: "metadata" })))
      .toContain("integrity_forbidden");
  });

  it("requires a pinned revision for snapshots and forbids one for bundled items", () => {
    expect(validateCatalogItem(snapshot({
      source: { registry: "hyperframes", url: null, revision: null, committedAt: null },
    }))).toContain("revision_required");
    expect(validateCatalogItem(bundled({ version: `git:${COMMIT}` }))).toContain("version_registry_mismatch");
    expect(validateCatalogItem(snapshot({ version: "1.2.0" }))).toContain("version_registry_mismatch");
    expect(validateCatalogItem(snapshot({
      source: { registry: "hyperframes", url: null, revision: OTHER_COMMIT, committedAt: null },
    }))).toContain("version_revision_mismatch");
  });

  it("keeps the entry inside the verified file set and out of the dependency closure", () => {
    expect(validateCatalogItem(bundled({ entry: "templates/other/scene.html" as RelPath })))
      .toContain("entry_not_in_package");
    expect(validateCatalogItem(bundled({ entry: "../escape.html" as RelPath })))
      .toContain("entry_not_relative");
    expect(validateCatalogItem(bundled({ dependencies: ["title-card"] })))
      .toContain("dependency_self_reference");
    expect(validateCatalogItem(bundled({ dependencies: ["Not A Slug"] })))
      .toContain("dependency_name_invalid");
  });

  it("enforces the normalized metadata bounds and the kebab name policy", () => {
    expect(CATALOG_NAME_PATTERN.test("lower-third")).toBe(true);
    expect(CATALOG_NAME_PATTERN.test("Lower-Third")).toBe(false);
    expect(CATALOG_NAME_PATTERN.test("lower--third")).toBe(false);
    expect(CATALOG_NAME_PATTERN.test("-lower")).toBe(false);
    expect(CATALOG_METADATA_LIMITS).toEqual({
      name: 128,
      title: 256,
      category: 64,
      tag: 64,
      description: 2_048,
      tags: 32,
    });
    expect(validateCatalogItem(bundled({ name: "a".repeat(129) }))).toContain("name_too_long");
    expect(validateCatalogItem(bundled({ title: "t".repeat(257) }))).toContain("title_too_long");
    expect(validateCatalogItem(bundled({ category: "c".repeat(65) }))).toContain("category_too_long");
    expect(validateCatalogItem(bundled({ description: "d".repeat(2_049) })))
      .toContain("description_too_long");
    expect(validateCatalogItem(bundled({ tags: ["t".repeat(65)] }))).toContain("tag_too_long");
    expect(validateCatalogItem(bundled({
      tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`),
    }))).toContain("too_many_tags");
    expect(validateCatalogItem(bundled({ tags: ["intro", "intro"] }))).toContain("tags_not_canonical");
    expect(validateCatalogItem(bundled({ tags: ["text", "intro"] }))).toContain("tags_not_canonical");
    // Composed and decomposed forms must not produce two representations.
    expect(validateCatalogItem(bundled({ tags: ["cafe\u0301"] }))).toContain("tags_not_canonical");
  });

  it("warns before mount when the item needs a newer HyperFrames than the pinned runtime", () => {
    expect(assessCatalogRuntimeCompatibility(snapshot())).toEqual({ status: "compatible" });
    expect(assessCatalogRuntimeCompatibility(snapshot({
      compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: "0.7.0" },
    }))).toEqual({ status: "compatible" });
    expect(assessCatalogRuntimeCompatibility(snapshot({
      compatibility: {
        aspectRatios: null,
        minWidth: null,
        fps: null,
        minHyperframesVersion: HYPERFRAMES_EXPECTED_VERSION,
      },
    }))).toEqual({ status: "compatible" });
    expect(assessCatalogRuntimeCompatibility(snapshot({
      compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: "0.8.0" },
    }))).toEqual({
      status: "incompatible",
      required: "0.8.0",
      runtime: HYPERFRAMES_EXPECTED_VERSION,
    });
    // Upstream `minCliVersion` may be loose; a comparable requirement is still answered.
    expect(assessCatalogRuntimeCompatibility(snapshot({
      compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: "0.8" },
    }))).toEqual({
      status: "incompatible",
      required: "0.8",
      runtime: HYPERFRAMES_EXPECTED_VERSION,
    });
    expect(assessCatalogRuntimeCompatibility(snapshot({
      compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: "^0.8" },
    }))).toEqual({ status: "unknown", required: "^0.8" });
  });

  it("topo-sorts the dependency closure and refuses cycles, gaps and unsupported kinds", () => {
    const manifests = new Map([
      ["lower-third", { dependencies: ["text-fx", "brand-colors"], kind: "block" as const }],
      ["text-fx", { dependencies: ["brand-colors"], kind: "component" as const }],
      ["brand-colors", { dependencies: [], kind: "component" as const }],
    ]);
    const ordered = orderCatalogDependencyClosure("lower-third", (name) => manifests.get(name));
    expect(ordered).toEqual({ ok: true, value: ["brand-colors", "text-fx"] });

    expect(orderCatalogDependencyClosure("lower-third", (name) => new Map([
      ["lower-third", { dependencies: ["text-fx"], kind: "block" as const }],
      ["text-fx", { dependencies: ["lower-third"], kind: "component" as const }],
    ]).get(name))).toEqual({ ok: false, error: { code: "dependency_cycle", name: "lower-third" } });

    expect(orderCatalogDependencyClosure("lower-third", (name) => new Map([
      ["lower-third", { dependencies: ["missing-dep"], kind: "block" as const }],
    ]).get(name))).toEqual({ ok: false, error: { code: "dependency_missing", name: "missing-dep" } });

    expect(orderCatalogDependencyClosure("lower-third", (name) => new Map([
      ["lower-third", { dependencies: ["scaffold"], kind: "block" as const }],
      ["scaffold", { dependencies: [], kind: "example" as const }],
    ]).get(name))).toEqual({
      ok: false,
      error: { code: "dependency_unsupported", name: "scaffold" },
    });

    expect(orderCatalogDependencyClosure("lower-third", () => undefined))
      .toEqual({ ok: false, error: { code: "dependency_missing", name: "lower-third" } });
  });
});
