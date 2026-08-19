import { describe, expect, it } from "vitest";

import { type ContentHash, type RelPath } from "@vidcom/contracts";
import {
  planCatalogInstall,
  type CatalogItem,
  type CatalogProvenance,
  type VerifiedCatalogItem,
} from "@vidcom/core";

const ENTRY = "blocks/lower-third/index.html" as RelPath;
const STYLE = "blocks/lower-third/style.css" as RelPath;
const DIGEST_ENTRY = "a".repeat(64);
const DIGEST_STYLE = "b".repeat(64);
const MANIFEST = "c".repeat(64);
const hash = (digest: string) => `sha256:${digest}` as ContentHash;

function item(overrides: Partial<CatalogItem> = {}): VerifiedCatalogItem {
  return {
    name: "lower-third",
    kind: "block",
    title: "Lower third",
    description: null,
    tags: ["social"],
    category: "Social",
    version: "1.2.0",
    integrity: { algo: "sha256", files: { [ENTRY]: DIGEST_ENTRY, [STYLE]: DIGEST_STYLE }, manifest: MANIFEST },
    materialization: "verified",
    source: { registry: "bundled", url: null, revision: null, committedAt: null },
    dependencies: [],
    compatibility: { aspectRatios: null, minWidth: null, fps: null, minHyperframesVersion: null },
    durationSeconds: 4,
    entry: ENTRY,
    preview: null,
    ...overrides,
  } as VerifiedCatalogItem;
}

const provenance = (overrides: Partial<CatalogProvenance> = {}): CatalogProvenance => ({
  name: "lower-third",
  title: "Lower third",
  description: null,
  category: "Social",
  tags: ["social"],
  registry: "bundled",
  version: "1.2.0",
  integrity: MANIFEST,
  ...overrides,
});

const absent = { [ENTRY]: null, [STYLE]: null } as Record<RelPath, ContentHash | null>;
const present = {
  [ENTRY]: hash(DIGEST_ENTRY),
  [STYLE]: hash(DIGEST_STYLE),
} as Record<RelPath, ContentHash | null>;

describe("catalog install planning and policy", () => {
  it("plans one create per file with explicit shallow-first parent directories", () => {
    const planned = planCatalogInstall({
      item: item(),
      targets: absent,
      installed: null,
      mount: { kind: "new-scene", toIndex: 0 },
      expectedRevision: 7,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok || planned.value.status !== "ready") throw new Error("expected a ready plan");
    const { plan } = planned.value;
    expect(plan.files).toEqual([
      { path: ENTRY, action: "create", fromHash: null, toDigest: DIGEST_ENTRY },
      { path: STYLE, action: "create", fromHash: null, toDigest: DIGEST_STYLE },
    ]);
    // Shallow first, deduplicated, and never the project root itself.
    expect(plan.directories).toEqual(["blocks", "blocks/lower-third"]);
    expect(plan.mountTarget).toBe(ENTRY);
    expect(plan.expectedRevision).toBe(7);
    // No target exists, so nothing may enter targetHashes: absence is locked by
    // the plan digest and an expected-null step instead of an invented hash.
    expect(plan.targetHashes).toEqual({});
  });

  it("enforces the mount invariant per kind", () => {
    expect(planCatalogInstall({
      item: item({ kind: "template" }),
      targets: absent,
      installed: null,
      mount: { kind: "into-scene", sceneId: "scene-1" },
      expectedRevision: 1,
    })).toEqual({ ok: false, error: { code: "mount_not_supported", kind: "template" } });

    for (const kind of ["motion-graphic", "start-end", "video"] as const) {
      expect(planCatalogInstall({
        item: item({ kind }),
        targets: absent,
        installed: null,
        mount: { kind: "new-scene", toIndex: 0 },
        expectedRevision: 1,
      })).toEqual({ ok: false, error: { code: "kind_not_installable", kind } });
    }

    const template = planCatalogInstall({
      item: item({ kind: "template" }),
      targets: absent,
      installed: null,
      mount: { kind: "new-scene", toIndex: 2 },
      expectedRevision: 1,
    });
    expect(template.ok).toBe(true);
  });

  it("asks before reinstalling an identical package and still mounts on reuse", () => {
    const input = {
      item: item(),
      targets: present,
      installed: provenance(),
      mount: { kind: "new-scene" as const, toIndex: 0 },
      expectedRevision: 3,
    };
    const asked = planCatalogInstall(input);
    expect(asked.ok).toBe(true);
    if (!asked.ok || asked.value.status !== "choice_required") throw new Error("expected a question");
    expect(asked.value.comparison).toBe("identical");
    expect(asked.value.choices).toEqual(["reuse", "skip"]);
    expect(asked.value.existing).toEqual({
      version: "1.2.0",
      integrity: MANIFEST,
      targetHashes: { [ENTRY]: hash(DIGEST_ENTRY), [STYLE]: hash(DIGEST_STYLE) },
    });
    expect(asked.value.candidate).toEqual({ version: "1.2.0", integrity: MANIFEST });

    const reused = planCatalogInstall({ ...input, existingPolicy: "reuse" });
    if (!reused.ok || reused.value.status !== "ready") throw new Error("expected a ready plan");
    expect(reused.value.plan.files.map((file) => file.action)).toEqual(["reuse", "reuse"]);
    // Reuse writes no file but still mounts, and the reused bytes become read
    // guards so another session cannot delete them underneath this mount.
    expect(reused.value.plan.readGuards).toEqual({
      [ENTRY]: hash(DIGEST_ENTRY),
      [STYLE]: hash(DIGEST_STYLE),
    });
    expect(reused.value.plan.targetHashes).toEqual(reused.value.plan.readGuards);
    expect(reused.value.plan.mountTarget).toBe(ENTRY);

    expect(planCatalogInstall({ ...input, existingPolicy: "replace" }))
      .toEqual({ ok: false, error: { code: "policy_not_allowed", policy: "replace" } });
    const skipped = planCatalogInstall({ ...input, existingPolicy: "skip" });
    expect(skipped).toEqual({ ok: true, value: { status: "skipped" } });
  });

  it("refuses the same version with a different digest instead of offering replace", () => {
    expect(planCatalogInstall({
      item: item(),
      targets: present,
      installed: provenance({ integrity: "d".repeat(64) }),
      mount: { kind: "new-scene", toIndex: 0 },
      expectedRevision: 3,
    })).toEqual({ ok: false, error: { code: "integrity_mismatch", version: "1.2.0" } });
  });

  it("offers only replace or skip for another version and for unmanaged files", () => {
    const older = planCatalogInstall({
      item: item(),
      targets: present,
      installed: provenance({ version: "1.0.0", integrity: "e".repeat(64) }),
      mount: { kind: "new-scene", toIndex: 0 },
      expectedRevision: 3,
    });
    if (!older.ok || older.value.status !== "choice_required") throw new Error("expected a question");
    expect(older.value.comparison).toBe("newer");
    expect(older.value.choices).toEqual(["replace", "skip"]);
    expect(older.value.existing.version).toBe("1.0.0");

    const unmanaged = planCatalogInstall({
      item: item(),
      targets: present,
      installed: null,
      mount: { kind: "new-scene", toIndex: 0 },
      expectedRevision: 3,
    });
    if (!unmanaged.ok || unmanaged.value.status !== "choice_required") throw new Error("expected a question");
    expect(unmanaged.value.comparison).toBe("unmanaged");
    expect(unmanaged.value.choices).toEqual(["replace", "skip"]);
    // No invented version or digest for a file the app did not install.
    expect(unmanaged.value.existing).toEqual({
      version: null,
      integrity: null,
      targetHashes: { [ENTRY]: hash(DIGEST_ENTRY), [STYLE]: hash(DIGEST_STYLE) },
    });

    expect(planCatalogInstall({
      item: item(),
      targets: present,
      installed: null,
      mount: { kind: "new-scene", toIndex: 0 },
      expectedRevision: 3,
      existingPolicy: "reuse",
    })).toEqual({ ok: false, error: { code: "policy_not_allowed", policy: "reuse" } });
  });

  it("binds the exact pre-image of every replaced file and creates the rest", () => {
    const replaced = planCatalogInstall({
      item: item(),
      targets: { [ENTRY]: hash("f".repeat(64)), [STYLE]: null } as Record<RelPath, ContentHash | null>,
      installed: null,
      mount: { kind: "into-scene", sceneId: "scene-2" },
      expectedRevision: 9,
      existingPolicy: "replace",
    });
    if (!replaced.ok || replaced.value.status !== "ready") throw new Error("expected a ready plan");
    expect(replaced.value.plan.files).toEqual([
      { path: ENTRY, action: "replace", fromHash: hash("f".repeat(64)), toDigest: DIGEST_ENTRY },
      { path: STYLE, action: "create", fromHash: null, toDigest: DIGEST_STYLE },
    ]);
    // Only the file that exists can appear here; the absent one stays expected-null.
    expect(replaced.value.plan.targetHashes).toEqual({ [ENTRY]: hash("f".repeat(64)) });
    expect(replaced.value.plan.mount).toEqual({ kind: "into-scene", sceneId: "scene-2" });
  });

  it("covers the whole plan in one canonical digest input", () => {
    const first = planCatalogInstall({
      item: item(),
      targets: absent,
      installed: null,
      mount: { kind: "new-scene", toIndex: 0 },
      expectedRevision: 1,
    });
    const moved = planCatalogInstall({
      item: item(),
      targets: absent,
      installed: null,
      mount: { kind: "new-scene", toIndex: 1 },
      expectedRevision: 1,
    });
    if (!first.ok || first.value.status !== "ready") throw new Error("expected a plan");
    if (!moved.ok || moved.value.status !== "ready") throw new Error("expected a plan");
    // Every field a grant must bind is inside the digest input, so moving the
    // mount or changing the policy cannot reuse an approved grant.
    expect(first.value.plan.digestInput).not.toEqual(moved.value.plan.digestInput);
    expect(Object.keys(first.value.plan.digestInput).sort()).toEqual([
      "existingPolicy",
      "expectedRevision",
      "files",
      "integrity",
      "mount",
      "mountTarget",
      "name",
      "readGuards",
      "version",
    ]);
  });
});
