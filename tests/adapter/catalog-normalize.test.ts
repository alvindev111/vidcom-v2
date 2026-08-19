import { describe, expect, it } from "vitest";

import { type RelPath } from "@vidcom/contracts";
import { orderCatalogDependencyClosure, type CatalogDependencyNode } from "@vidcom/core";

import {
  CATALOG_CATEGORY_RULES,
  CATALOG_CATEGORY_RULE_VERSION,
  normalizeBundledCatalogItem,
  normalizeUpstreamCatalogItem,
  resolveCatalogCategory,
} from "@vidcom/adapter";
const COMMIT = "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c";
const COMMITTED_AT = "2026-08-10T10:00:00Z";

function block(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "lower-third",
    type: "hyperframes:block",
    title: "Lower third",
    description: "Animated lower third",
    tags: ["social", "text"],
    dimensions: { width: 1920, height: 1080 },
    duration: 4,
    files: [
      { path: "index.html", target: "blocks/lower-third/index.html", type: "hyperframes:composition" },
      { path: "style.css", target: "blocks/lower-third/style.css", type: "hyperframes:style" },
    ],
    ...overrides,
  };
}

const noDependencies = (): CatalogDependencyNode | undefined => undefined;

function upstream(manifest: Record<string, unknown>, lookup = noDependencies) {
  return normalizeUpstreamCatalogItem({
    entry: { name: String(manifest.name ?? ""), type: String(manifest.type ?? "") },
    manifest,
    revision: COMMIT,
    committedAt: COMMITTED_AT,
    lookup,
  });
}

describe("HyperFrames 0.7.86 registry normalization", () => {
  it("maps only a top-level block and pins it to the exact commit", () => {
    const result = upstream(block());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.item).toMatchObject({
      name: "lower-third",
      kind: "block",
      title: "Lower third",
      description: "Animated lower third",
      tags: ["social", "text"],
      version: `git:${COMMIT}`,
      integrity: null,
      materialization: "metadata",
      dependencies: [],
      durationSeconds: 4,
      entry: "blocks/lower-third/index.html",
      preview: null,
    });
    expect(result.item.source).toEqual({
      registry: "hyperframes",
      url: `https://raw.githubusercontent.com/heygen-com/hyperframes/${COMMIT}`
        + "/registry/blocks/lower-third/registry-item.json",
      revision: COMMIT,
      committedAt: COMMITTED_AT,
    });
  });

  it("refuses examples and standalone components with stable diagnostics", () => {
    const example = upstream({
      ...block(),
      type: "hyperframes:example",
    });
    expect(example).toEqual({ ok: false, diagnostics: ["item_type_unsupported"] });
    const component = upstream({
      name: "sparkle",
      type: "hyperframes:component",
      title: "Sparkle",
      description: "Sparkles",
      files: [{ path: "s.html", target: "components/sparkle/s.html", type: "hyperframes:composition" }],
    });
    expect(component).toEqual({ ok: false, diagnostics: ["item_type_unsupported"] });
    expect(upstream({ ...block(), type: "hyperframes:template" }))
      .toEqual({ ok: false, diagnostics: ["item_type_unsupported"] });
  });

  it("requires exactly one top-level composition and never borrows a dependency entry", () => {
    expect(upstream(block({
      files: [{ path: "style.css", target: "blocks/x/style.css", type: "hyperframes:style" }],
      name: "no-entry",
    }))).toEqual({ ok: false, diagnostics: ["entry_missing"] });

    expect(upstream(block({
      name: "two-entries",
      files: [
        { path: "a.html", target: "blocks/two-entries/a.html", type: "hyperframes:composition" },
        { path: "b.html", target: "blocks/two-entries/b.html", type: "hyperframes:composition" },
      ],
    }))).toEqual({ ok: false, diagnostics: ["entry_ambiguous"] });

    // A dependency's composition may not stand in for the missing top-level entry.
    const lookup = (name: string): CatalogDependencyNode | undefined =>
      name === "sparkle" ? { dependencies: [], kind: "component" } : undefined;
    expect(upstream(block({
      name: "borrowed",
      registryDependencies: ["sparkle"],
      files: [{ path: "style.css", target: "blocks/borrowed/style.css", type: "hyperframes:style" }],
    }), lookup as typeof noDependencies)).toEqual({ ok: false, diagnostics: ["entry_missing"] });
  });

  it("never lets a catalog item claim the project root entry or escape the project", () => {
    expect(upstream(block({
      name: "root-grab",
      files: [{ path: "index.html", target: "index.html", type: "hyperframes:composition" }],
    }))).toEqual({ ok: false, diagnostics: ["target_reserved"] });

    expect(upstream(block({
      name: "escape",
      files: [{ path: "index.html", target: "../outside.html", type: "hyperframes:composition" }],
    }))).toEqual({ ok: false, diagnostics: ["target_invalid"] });

    expect(upstream(block({
      name: "absolute",
      files: [{ path: "index.html", target: "/etc/passwd", type: "hyperframes:composition" }],
    }))).toEqual({ ok: false, diagnostics: ["target_invalid"] });

    expect(upstream(block({
      name: "duplicate-target",
      files: [
        { path: "a.html", target: "blocks/duplicate-target/index.html", type: "hyperframes:composition" },
        { path: "b.css", target: "blocks/duplicate-target/index.html", type: "hyperframes:style" },
      ],
    }))).toEqual({ ok: false, diagnostics: ["target_duplicate"] });
  });

  it("rejects a non-slug name instead of interpolating it into a URL or path", () => {
    const escaped = upstream(block({ name: "../../etc/passwd" }));
    expect(escaped).toEqual({ ok: false, diagnostics: ["name_invalid"] });
    expect(upstream(block({ name: "Lower_Third" })))
      .toEqual({ ok: false, diagnostics: ["name_invalid"] });
    expect(upstream(block({ name: "a".repeat(129) })))
      .toEqual({ ok: false, diagnostics: ["name_too_long"] });
    expect(normalizeUpstreamCatalogItem({
      entry: { name: "other-name", type: "hyperframes:block" },
      manifest: block(),
      revision: COMMIT,
      committedAt: COMMITTED_AT,
      lookup: noDependencies,
    })).toEqual({ ok: false, diagnostics: ["name_mismatch"] });
  });

  it("canonicalizes tags and enforces the normalized metadata bounds", () => {
    const canonical = upstream(block({ tags: ["text", "social", "text", "caf\u0065\u0301"] }));
    expect(canonical.ok).toBe(true);
    if (canonical.ok) expect(canonical.item.tags).toEqual(["caf\u00e9", "social", "text"]);

    expect(upstream(block({ tags: Array.from({ length: 33 }, (_, i) => `t-${i}`) })))
      .toEqual({ ok: false, diagnostics: ["too_many_tags"] });
    expect(upstream(block({ title: "t".repeat(257) })))
      .toEqual({ ok: false, diagnostics: ["title_too_long"] });
    expect(upstream(block({ description: "d".repeat(2_049) })))
      .toEqual({ ok: false, diagnostics: ["description_too_long"] });
    expect(upstream(block({ tags: ["t".repeat(65)] })))
      .toEqual({ ok: false, diagnostics: ["tag_too_long"] });
  });

  it("normalizes minCliVersion and the shape of every optional upstream field", () => {
    const compatible = upstream(block({ minCliVersion: "0.7.0" }));
    expect(compatible.ok).toBe(true);
    if (compatible.ok) {
      expect(compatible.item.compatibility).toEqual({
        aspectRatios: null,
        minWidth: 1920,
        fps: null,
        minHyperframesVersion: "0.7.0",
      });
    }
    expect(upstream(block({ minCliVersion: 7 })))
      .toEqual({ ok: false, diagnostics: ["manifest_invalid"] });
    expect(upstream(block({ duration: 0 })))
      .toEqual({ ok: false, diagnostics: ["manifest_invalid"] });
    expect(upstream(block({ files: [] })))
      .toEqual({ ok: false, diagnostics: ["manifest_invalid"] });
    expect(upstream(block({ dimensions: { width: 0, height: 1080 } })))
      .toEqual({ ok: false, diagnostics: ["manifest_invalid"] });
    expect(upstream({ name: "lower-third", type: "hyperframes:block" }))
      .toEqual({ ok: false, diagnostics: ["manifest_invalid"] });
  });

  it("resolves a versioned VidCom category from tags then name, falling back to Other", () => {
    expect(CATALOG_CATEGORY_RULE_VERSION).toBe(1);
    expect(CATALOG_CATEGORY_RULES.length).toBeGreaterThan(0);
    expect(resolveCatalogCategory({ name: "wipe-left", tags: ["transitions"] })).toBe("Transitions");
    expect(resolveCatalogCategory({ name: "karaoke-captions", tags: [] })).toBe("Captions");
    expect(resolveCatalogCategory({ name: "unknown-thing", tags: ["mystery"] })).toBe("Other");
    // Fixed priority: the first matching rule wins even when several tags match.
    expect(resolveCatalogCategory({ name: "x", tags: ["social", "transitions"] })).toBe("Transitions");
  });

  it("carries the resolved dependency closure in topo order", () => {
    const nodes = new Map<string, CatalogDependencyNode>([
      ["lower-third", { dependencies: ["text-fx"], kind: "block" }],
      ["text-fx", { dependencies: ["brand-colors"], kind: "component" }],
      ["brand-colors", { dependencies: [], kind: "component" }],
    ]);
    const lookup = (name: string) => nodes.get(name);
    const result = upstream(block({ registryDependencies: ["text-fx"] }), lookup as typeof noDependencies);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.item.dependencies).toEqual(["brand-colors", "text-fx"]);
    expect(orderCatalogDependencyClosure("lower-third", lookup))
      .toEqual({ ok: true, value: ["brand-colors", "text-fx"] });

    const cyclic = new Map<string, CatalogDependencyNode>([
      ["lower-third", { dependencies: ["loop"], kind: "block" }],
      ["loop", { dependencies: ["lower-third"], kind: "component" }],
    ]);
    expect(upstream(
      block({ registryDependencies: ["loop"] }),
      ((name: string) => cyclic.get(name)) as typeof noDependencies,
    )).toEqual({ ok: false, diagnostics: ["dependency_cycle"] });
  });

  it("normalizes a curated bundled template with an explicit entry and semver", () => {
    const template = normalizeBundledCatalogItem({
      name: "title-card",
      kind: "template",
      title: "Title card",
      description: null,
      category: "Openers",
      tags: ["text", "intro"],
      version: "1.2.0",
      entry: "templates/title-card/scene.html" as RelPath,
      durationSeconds: 4,
      compatibility: { aspectRatios: ["16:9"], minWidth: 1920, fps: [30], minHyperframesVersion: "0.7.0" },
      preview: { kind: "image", path: "templates/title-card/preview.png" as RelPath },
      integrity: {
        algo: "sha256",
        files: {
          ["templates/title-card/scene.html" as RelPath]: "a".repeat(64),
          ["templates/title-card/preview.png" as RelPath]: "c".repeat(64),
        },
        manifest: "b".repeat(64),
      },
      dependencies: [],
    });
    expect(template.ok).toBe(true);
    if (!template.ok) return;
    expect(template.item).toMatchObject({
      kind: "template",
      category: "Openers",
      tags: ["intro", "text"],
      version: "1.2.0",
      materialization: "verified",
      entry: "templates/title-card/scene.html",
      source: { registry: "bundled", url: null, revision: null, committedAt: null },
    });

    const rootGrab = normalizeBundledCatalogItem({
      name: "root-template",
      kind: "template",
      title: "Root",
      description: null,
      category: "Openers",
      tags: [],
      version: "1.0.0",
      entry: "index.html" as RelPath,
      durationSeconds: null,
      compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
      preview: null,
      integrity: { algo: "sha256", files: { ["index.html" as RelPath]: "a".repeat(64) }, manifest: "b".repeat(64) },
      dependencies: [],
    });
    expect(rootGrab).toEqual({ ok: false, diagnostics: ["target_reserved"] });

    const strayEntry = normalizeBundledCatalogItem({
      name: "stray",
      kind: "template",
      title: "Stray",
      description: null,
      category: "Openers",
      tags: [],
      version: "1.0.0",
      entry: "templates/stray/scene.html" as RelPath,
      durationSeconds: null,
      compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
      preview: null,
      integrity: {
        algo: "sha256",
        files: { ["templates/stray/other.html" as RelPath]: "a".repeat(64) },
        manifest: "b".repeat(64),
      },
      dependencies: [],
    });
    expect(strayEntry).toEqual({ ok: false, diagnostics: ["entry_not_in_package"] });
  });
});
