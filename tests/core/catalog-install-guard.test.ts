import { describe, expect, it } from "vitest";

import { type ContentHash, type RelPath } from "@vidcom/contracts";
import { verifyCatalogPackage, type CatalogItem, type VerifiedCatalogItem } from "@vidcom/core";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const MANIFEST_DIGEST = "c".repeat(64);

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    name: "lower-third",
    kind: "block",
    title: "Lower third",
    description: null,
    tags: ["social"],
    category: "Social",
    version: "1.0.0",
    integrity: {
      algo: "sha256",
      files: {
        ["blocks/lower-third/index.html" as RelPath]: DIGEST_A,
        ["blocks/lower-third/style.css" as RelPath]: DIGEST_B,
      },
      manifest: MANIFEST_DIGEST,
    },
    materialization: "verified",
    source: { registry: "bundled", url: null, revision: null, committedAt: null },
    dependencies: [],
    compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
    durationSeconds: 4,
    entry: "blocks/lower-third/index.html" as RelPath,
    preview: null,
    ...overrides,
  };
}

const files = (
  entries: [string, string][] = [
    ["blocks/lower-third/index.html", DIGEST_A],
    ["blocks/lower-third/style.css", DIGEST_B],
  ],
) => entries.map(([target, digest]) => ({
  path: target as RelPath,
  contentHash: `sha256:${digest}` as ContentHash,
}));

describe("verified catalog package guard before any write", () => {
  it("accepts a package whose exact file set, digests and manifest digest all match", () => {
    const verified = verifyCatalogPackage({
      item: item(),
      files: files(),
      manifestDigest: MANIFEST_DIGEST,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      const value: VerifiedCatalogItem = verified.value;
      expect(value.materialization).toBe("verified");
    }
  });

  it("refuses an item that is still metadata-only", () => {
    expect(verifyCatalogPackage({
      item: item({ materialization: "metadata", integrity: null }),
      files: files(),
      manifestDigest: MANIFEST_DIGEST,
    })).toEqual({ ok: false, error: { code: "not_verified" } });
  });

  it("refuses any path that escapes the project or is not relative", () => {
    for (const escape of ["../outside.html", "/etc/passwd", "blocks/../../x.html", "C:\\windows\\x"]) {
      const guarded = verifyCatalogPackage({
        item: item({
          integrity: {
            algo: "sha256",
            files: { [escape as RelPath]: DIGEST_A },
            manifest: MANIFEST_DIGEST,
          },
          entry: escape as RelPath,
        }),
        files: files([[escape, DIGEST_A]]),
        manifestDigest: MANIFEST_DIGEST,
      });
      expect(guarded, escape).toEqual({ ok: false, error: { code: "path_escape", path: escape } });
    }
  });

  it("refuses two materialized files that target one path", () => {
    expect(verifyCatalogPackage({
      item: item(),
      files: files([
        ["blocks/lower-third/index.html", DIGEST_A],
        ["blocks/lower-third/index.html", DIGEST_A],
        ["blocks/lower-third/style.css", DIGEST_B],
      ]),
      manifestDigest: MANIFEST_DIGEST,
    })).toEqual({
      ok: false,
      error: { code: "path_duplicate", path: "blocks/lower-third/index.html" },
    });
  });

  it("requires the exact file set, rejecting both a missing and an extra file", () => {
    expect(verifyCatalogPackage({
      item: item(),
      files: files([["blocks/lower-third/index.html", DIGEST_A]]),
      manifestDigest: MANIFEST_DIGEST,
    })).toEqual({
      ok: false,
      error: {
        code: "file_set_mismatch",
        missing: ["blocks/lower-third/style.css"],
        unexpected: [],
      },
    });

    expect(verifyCatalogPackage({
      item: item(),
      files: files([
        ["blocks/lower-third/index.html", DIGEST_A],
        ["blocks/lower-third/style.css", DIGEST_B],
        ["blocks/lower-third/extra.js", DIGEST_A],
      ]),
      manifestDigest: MANIFEST_DIGEST,
    })).toEqual({
      ok: false,
      error: {
        code: "file_set_mismatch",
        missing: [],
        unexpected: ["blocks/lower-third/extra.js"],
      },
    });
  });

  it("refuses a single wrong file digest and a wrong manifest digest", () => {
    expect(verifyCatalogPackage({
      item: item(),
      files: files([
        ["blocks/lower-third/index.html", DIGEST_A],
        ["blocks/lower-third/style.css", DIGEST_A],
      ]),
      manifestDigest: MANIFEST_DIGEST,
    })).toEqual({
      ok: false,
      error: { code: "file_digest_mismatch", path: "blocks/lower-third/style.css" },
    });

    expect(verifyCatalogPackage({
      item: item(),
      files: files(),
      manifestDigest: "d".repeat(64),
    })).toEqual({ ok: false, error: { code: "manifest_digest_mismatch" } });
  });

  it("refuses an entry that is not one of the verified files", () => {
    expect(verifyCatalogPackage({
      item: item({ entry: "blocks/lower-third/other.html" as RelPath }),
      files: files(),
      manifestDigest: MANIFEST_DIGEST,
    })).toEqual({ ok: false, error: { code: "entry_not_in_package" } });
  });
});
