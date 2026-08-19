import { describe, expect, it } from "vitest";

import { parseHTML } from "linkedom";

import { type RelPath } from "@vidcom/contracts";
import { type VerifiedCatalogItem } from "@vidcom/core";

import { parseCatalogProvenance, writeCatalogProvenance } from "@vidcom/adapter";

const HOSTILE_TITLE = '"><script>alert(1)</script>';

function item(overrides: Partial<VerifiedCatalogItem> = {}): VerifiedCatalogItem {
  return {
    name: "lower-third",
    kind: "block",
    title: "Lower third",
    description: "A lower third",
    tags: ["social", "text"],
    category: "Social",
    version: "git:9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c",
    integrity: {
      algo: "sha256",
      files: { ["blocks/lower-third/index.html" as RelPath]: "a".repeat(64) },
      manifest: "b".repeat(64),
    },
    materialization: "verified",
    source: {
      registry: "hyperframes",
      url: null,
      revision: "9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c",
      committedAt: "2026-08-10T10:00:00Z",
    },
    dependencies: [],
    compatibility: { aspectRatios: null, minWidth: 1920, fps: null, minHyperframesVersion: null },
    durationSeconds: 4,
    entry: "blocks/lower-third/index.html" as RelPath,
    preview: null,
    ...overrides,
  };
}

function mounted(source: VerifiedCatalogItem): { html: string; attribute: string } {
  const { document } = parseHTML(
    "<!doctype html><html><head></head><body><section id=\"host\"></section></body></html>",
  );
  const host = document.querySelector("#host")!;
  writeCatalogProvenance(host as unknown as Element, source);
  return {
    html: document.toString(),
    attribute: (host as unknown as Element).getAttribute("data-catalog-provenance") ?? "",
  };
}

describe("catalog provenance attribute", () => {
  it("writes one canonical attribute that round-trips to the same object", () => {
    const source = item();
    const { attribute } = mounted(source);
    const parsed = parseCatalogProvenance(attribute);
    expect(parsed).toEqual({
      name: "lower-third",
      title: "Lower third",
      description: "A lower third",
      category: "Social",
      tags: ["social", "text"],
      registry: "hyperframes",
      version: "git:9f2c1b7a4d5e6f708192a3b4c5d6e7f8091a2b3c",
      integrity: "b".repeat(64),
    });
    // Canonical JSON: sorted keys and no whitespace, so the same package always
    // produces the same attribute bytes.
    expect(attribute.startsWith('{"category":')).toBe(true);
    expect(attribute).not.toContain(" \n");
  });

  it("keeps hostile metadata inside the attribute instead of the markup", () => {
    const { html, attribute } = mounted(item({
      title: HOSTILE_TITLE,
      description: "</section><img src=x onerror=alert(1)>",
    }));
    // Escaped at the JSON level, so the serialized attribute holds no
    // markup-looking bytes and re-parsing creates no new node or attribute.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html.match(/<section/gu)).toHaveLength(1);
    expect(parseCatalogProvenance(attribute)?.title).toBe(HOSTILE_TITLE);

    const { document } = parseHTML(html);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelectorAll("section")).toHaveLength(1);
    const host = document.querySelector("#host")!;
    expect(host.getAttributeNames().sort()).toEqual(["data-catalog-provenance", "id"]);
    const reread = host.getAttribute("data-catalog-provenance") ?? "";
    expect(parseCatalogProvenance(reread)?.description).toBe("</section><img src=x onerror=alert(1)>");
  });

  it("rejects an attribute that is not canonical provenance", () => {
    for (const invalid of ["", "{}", "null", "[]", "{\"name\":1}", "not json"]) {
      expect(parseCatalogProvenance(invalid), invalid).toBeNull();
    }
  });
});
