import { describe, expect, it } from "vitest";

import { type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  assembleCatalogInstallComposite,
  planCatalogInstall,
  type AbsolutePath,
  type CatalogInstallPlan,
  type CatalogMaterializedFile,
  type CatalogProvenance,
  type ProjectRef,
  type VerifiedCatalogItem,
} from "@vidcom/core";

const ENTRY = "blocks/lower-third/index.html" as RelPath;
const STYLE = "blocks/lower-third/style.css" as RelPath;
const DIGEST_ENTRY = "a".repeat(64);
const DIGEST_STYLE = "b".repeat(64);
const MANIFEST = "c".repeat(64);
const hash = (digest: string) => `sha256:${digest}` as ContentHash;

const ref = {
  id: "project_x" as ProjectId,
  slug: "x",
  root: "/w/x" as AbsolutePath,
  entry: "index.html" as RelPath,
} as ProjectRef;

function item(overrides: Partial<VerifiedCatalogItem> = {}): VerifiedCatalogItem {
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

const materialized = (): CatalogMaterializedFile[] => [
  {
    path: ENTRY,
    contentHash: hash(DIGEST_ENTRY),
    source: { sourcePath: "/app/cache/entry" as AbsolutePath, contentHash: hash(DIGEST_ENTRY) },
    encoding: "utf8",
  },
  {
    path: STYLE,
    contentHash: hash(DIGEST_STYLE),
    source: { sourcePath: "/app/cache/style" as AbsolutePath, contentHash: hash(DIGEST_STYLE) },
    encoding: "utf8",
  },
];

const provenance: CatalogProvenance = {
  name: "lower-third",
  title: "Lower third",
  description: null,
  category: "Social",
  tags: ["social"],
  registry: "bundled",
  version: "1.2.0",
  integrity: MANIFEST,
};

function readyPlan(
  targets: Record<RelPath, ContentHash | null>,
  options: { policy?: "reuse" | "replace"; installed?: CatalogProvenance | null; into?: boolean } = {},
): CatalogInstallPlan {
  const planned = planCatalogInstall({
    item: item(),
    targets,
    installed: options.installed ?? null,
    mount: options.into ? { kind: "into-scene", sceneId: "scene-2" } : { kind: "new-scene", toIndex: 0 },
    expectedRevision: 4,
    ...(options.policy ? { existingPolicy: options.policy } : {}),
  });
  if (!planned.ok || planned.value.status !== "ready") throw new Error("expected a ready plan");
  return planned.value.plan;
}

const absent = { [ENTRY]: null, [STYLE]: null } as Record<RelPath, ContentHash | null>;
const present = {
  [ENTRY]: hash(DIGEST_ENTRY),
  [STYLE]: hash(DIGEST_STYLE),
} as Record<RelPath, ContentHash | null>;

const origin = {
  kind: "ui" as const,
  sessionId: "s",
  label: "Install lower-third",
  historyAction: "record" as const,
  historyOperation: null,
};

describe("one composite for catalog files, mount and provenance", () => {
  it("orders parents, staged writes and the mount into a single request", () => {
    const built = assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan: readyPlan(absent),
      files: materialized(),
      documents: [
        { path: "compositions/scene-3.html" as RelPath, content: "<section/>", expectedContentHash: null },
        { path: "index.html" as RelPath, content: "<main/>", expectedContentHash: hash("f".repeat(64)) },
      ],
      provenance,
      origin,
      toolAudit: null,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const request = built.value;
    expect(request.steps.map((step) => [step.kind, "path" in step ? step.path : null])).toEqual([
      ["mkdir", "blocks"],
      ["mkdir", "blocks/lower-third"],
      ["write-staged", ENTRY],
      ["write-staged", STYLE],
      ["write", "compositions/scene-3.html"],
      ["write", "index.html"],
    ]);
    const parents = request.steps.filter((step) => step.kind === "mkdir");
    expect(parents.every((step) => step.kind === "mkdir" && step.expectExisting === "either")).toBe(true);
    const staged = request.steps.filter((step) => step.kind === "write-staged");
    expect(staged).toEqual([
      {
        kind: "write-staged",
        path: ENTRY,
        source: { sourcePath: "/app/cache/entry", contentHash: hash(DIGEST_ENTRY) },
        expectedContentHash: null,
        undoable: true,
      },
      {
        kind: "write-staged",
        path: STYLE,
        source: { sourcePath: "/app/cache/style", contentHash: hash(DIGEST_STYLE) },
        expectedContentHash: null,
        undoable: true,
      },
    ]);
    // One mutation, no nested use case, and no verified backup: nothing is deleted.
    expect(request.backup).toBe(false);
    expect(request.historyReadGuards ?? []).toEqual([]);
    expect(request.origin).toEqual(origin);
  });

  it("binds the exact pre-image of a replaced file", () => {
    const built = assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan: readyPlan({ [ENTRY]: hash("f".repeat(64)), [STYLE]: null } as Record<RelPath, ContentHash | null>, {
        policy: "replace",
      }),
      files: materialized(),
      documents: [{ path: "index.html" as RelPath, content: "<main/>", expectedContentHash: hash("e".repeat(64)) }],
      provenance,
      origin,
      toolAudit: null,
    });
    if (!built.ok) throw new Error("expected a request");
    const staged = built.value.steps.filter((step) => step.kind === "write-staged");
    expect(staged.map((step) => step.kind === "write-staged" && step.expectedContentHash))
      .toEqual([hash("f".repeat(64)), null]);
  });

  it("writes no package file for a reuse but still mounts under read guards", () => {
    const built = assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan: readyPlan(present, { policy: "reuse", installed: provenance }),
      files: materialized(),
      documents: [
        { path: "compositions/scene-3.html" as RelPath, content: "<section/>", expectedContentHash: null },
        { path: "index.html" as RelPath, content: "<main/>", expectedContentHash: hash("f".repeat(64)) },
      ],
      provenance,
      origin,
      toolAudit: null,
    });
    if (!built.ok) throw new Error("expected a request");
    const request = built.value;
    expect(request.steps.filter((step) => step.kind === "write-staged")).toEqual([]);
    // No package directory is created either: nothing is written there.
    expect(request.steps.filter((step) => step.kind === "mkdir")).toEqual([]);
    expect(request.steps.map((step) => step.kind)).toEqual(["write", "write"]);
    expect(request.historyReadGuards).toEqual([
      { path: ENTRY, state: { kind: "file", contentHash: hash(DIGEST_ENTRY) } },
      { path: STYLE, state: { kind: "file", contentHash: hash(DIGEST_STYLE) } },
    ]);
  });

  it("mounts into an existing scene without touching the root entry", () => {
    const built = assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan: readyPlan(absent, { into: true }),
      files: materialized(),
      documents: [{
        path: "compositions/scene-2.html" as RelPath,
        content: "<section/>",
        expectedContentHash: hash("d".repeat(64)),
      }],
      provenance,
      origin,
      toolAudit: null,
    });
    if (!built.ok) throw new Error("expected a request");
    const writes = built.value.steps.filter((step) => step.kind === "write");
    expect(writes.map((step) => step.kind === "write" && step.path)).toEqual(["compositions/scene-2.html"]);
  });

  it("refuses a staged set that does not match the plan exactly", () => {
    const plan = readyPlan(absent);
    expect(assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan,
      files: [materialized()[0]!],
      documents: [{ path: "index.html" as RelPath, content: "<main/>", expectedContentHash: null }],
      provenance,
      origin,
      toolAudit: null,
    })).toEqual({ ok: false, error: { code: "staged_set_mismatch", missing: [STYLE], unexpected: [] } });

    expect(assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan,
      files: [
        materialized()[0]!,
        { ...materialized()[1]!, contentHash: hash("9".repeat(64)) },
      ],
      documents: [{ path: "index.html" as RelPath, content: "<main/>", expectedContentHash: null }],
      provenance,
      origin,
      toolAudit: null,
    })).toEqual({ ok: false, error: { code: "staged_digest_mismatch", path: STYLE } });
  });

  it("requires at least one mount document and rejects a duplicate document path", () => {
    const plan = readyPlan(absent);
    expect(assembleCatalogInstallComposite({
      ref, item: item(), plan, files: materialized(), documents: [], provenance, origin, toolAudit: null,
    })).toEqual({ ok: false, error: { code: "mount_document_missing" } });

    expect(assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan,
      files: materialized(),
      documents: [
        { path: "index.html" as RelPath, content: "<main/>", expectedContentHash: null },
        { path: "index.html" as RelPath, content: "<main/>", expectedContentHash: null },
      ],
      provenance,
      origin,
      toolAudit: null,
    })).toEqual({ ok: false, error: { code: "document_duplicate", path: "index.html" } });
  });

  it("refuses a document that would overwrite a package file", () => {
    expect(assembleCatalogInstallComposite({
      ref,
      item: item(),
      plan: readyPlan(absent),
      files: materialized(),
      documents: [{ path: ENTRY, content: "<main/>", expectedContentHash: null }],
      provenance,
      origin,
      toolAudit: null,
    })).toEqual({ ok: false, error: { code: "document_collides_with_package", path: ENTRY } });
  });
});
