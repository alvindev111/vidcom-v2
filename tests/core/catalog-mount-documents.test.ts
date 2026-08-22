import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  parseCatalogProvenance,
  planCatalogMountDocuments,
  type AbsolutePath,
  type CompositionOp,
  type ProjectRef,
  type VerifiedCatalogItem,
} from "@vidcom/core";

const ENTRY = "blocks/lower-third/index.html" as RelPath;
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
    integrity: { algo: "sha256", files: { [ENTRY]: "a".repeat(64) }, manifest: MANIFEST },
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

const model = {
  project: { id: "project_x", width: 1920, height: 1080, duration: 8, sceneCount: 2 },
  scenes: [
    { id: "scene-1", src: "compositions/scene-1.html", start: 0, duration: 4, trackIndex: 0 },
    { id: "scene-2", src: "compositions/scene-2.html", start: 4, duration: 4, trackIndex: 0 },
  ],
} as never;

function compositionPort() {
  const calls: { path: RelPath; ops: readonly CompositionOp[] }[] = [];
  return {
    calls,
    applyOps: async (_ref: ProjectRef, path: RelPath, ops: readonly CompositionOp[]) => {
      calls.push({ path, ops });
      return { ok: true as const, value: `<!-- ${path} -->${JSON.stringify(ops)}` };
    },
  };
}

describe("catalog mount document planning", () => {
  it("mounts a new scene directly from the package entry through the shared planner", async () => {
    const composition = compositionPort();
    const planned = await planCatalogMountDocuments({
      ref,
      model,
      item: item(),
      mount: { kind: "new-scene", toIndex: 2 },
      entryHash: hash("e".repeat(64)),
      composition,
      now: () => new Date("2026-08-19T00:00:00.000Z"),
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { documents, sceneId, scenePath } = planned.value;
    expect(sceneId).toBe("scene-3");
    expect(scenePath).toBe(ENTRY);
    expect(documents.map((document) => document.path)).toEqual([
      "narration/scene-3.json",
      "index.html",
    ]);

    // The root mounts the package directly and carries instance provenance; a
    // second external wrapper would render blank in the one-level runtime.
    const root = documents[1]!;
    const added = composition.calls[0]!.ops[0] as Extract<CompositionOp, { kind: "addElement" }>;
    expect(added.value.html).toContain(`data-composition-src="${ENTRY}"`);
    expect(added.value.html).toContain('data-composition-id="scene-3"');
    const attribute = /data-catalog-provenance="([^"]*)"/u.exec(added.value.html)?.[1] ?? "";
    expect(parseCatalogProvenance(attribute.replaceAll("&quot;", '"'))).toMatchObject({
      name: "lower-third",
      version: "1.2.0",
      integrity: MANIFEST,
      registry: "bundled",
    });

    // Root timing comes from the shared insertion planner, not from new arithmetic.
    expect(root.expectedContentHash).toBe(hash("e".repeat(64)));
    expect(composition.calls).toHaveLength(1);
    expect(composition.calls[0]!.path).toBe("index.html");
    const kinds = composition.calls[0]!.ops.map((op) => op.kind);
    expect(kinds).toContain("addElement");
  });

  it("gives two inserts of the same item distinct scene identities", async () => {
    const first = await planCatalogMountDocuments({
      ref, model, item: item(), mount: { kind: "new-scene", toIndex: 2 },
      entryHash: null, composition: compositionPort(), now: () => new Date(),
    });
    if (!first.ok) throw new Error("expected a plan");
    const withFirst = {
      project: { ...(model as never as { project: object }).project, sceneCount: 3 },
      scenes: [
        ...(model as never as { scenes: object[] }).scenes,
        { id: first.value.sceneId, src: first.value.scenePath, start: 8, duration: 4, trackIndex: 0 },
      ],
    } as never;
    const second = await planCatalogMountDocuments({
      ref, model: withFirst, item: item(), mount: { kind: "new-scene", toIndex: 3 },
      entryHash: null, composition: compositionPort(), now: () => new Date(),
    });
    if (!second.ok) throw new Error("expected a plan");
    expect(second.value.sceneId).not.toBe(first.value.sceneId);
    expect(second.value.scenePath).toBe(first.value.scenePath);
  });

  it("maps a storyboard append to the local slot of the selected track", async () => {
    const composition = compositionPort();
    const multiTrack = {
      project: { id: "project_x", width: 1920, height: 1080, duration: 8, sceneCount: 2 },
      scenes: [
        { id: "scene-1", src: "compositions/scene-1.html", start: 0, duration: 4, trackIndex: 0 },
        { id: "scene-2", src: "compositions/scene-2.html", start: 4, duration: 4, trackIndex: 1 },
      ],
    } as never;
    const planned = await planCatalogMountDocuments({
      ref,
      model: multiTrack,
      item: item(),
      mount: { kind: "new-scene", toIndex: 2 },
      entryHash: null,
      composition,
      now: () => new Date(),
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.rootDuration).toBe(12);
    const added = composition.calls[0]!.ops[0] as Extract<CompositionOp, { kind: "addElement" }>;
    expect(added.value.html).toContain('data-start="8"');
    expect(added.value.html).toContain('data-track-index="1"');
  });

  it("rejects a storyboard slot beyond the global scene list", async () => {
    const planned = await planCatalogMountDocuments({
      ref,
      model,
      item: item(),
      mount: { kind: "new-scene", toIndex: 3 },
      entryHash: null,
      composition: compositionPort(),
      now: () => new Date(),
    });
    expect(planned).toMatchObject({
      ok: false,
      error: {
        code: "insertion_rejected",
        error: { code: ErrorCode.SchemaInvalid, field: "toIndex" },
      },
    });
  });

  it("adds one clamped overlay layer when mounting into an existing scene", async () => {
    const composition = compositionPort();
    const planned = await planCatalogMountDocuments({
      ref,
      model,
      item: item({ durationSeconds: 10 }),
      mount: { kind: "into-scene", sceneId: "scene-2" },
      entryHash: hash("d".repeat(64)),
      sceneHash: hash("b".repeat(64)),
      composition,
      now: () => new Date(),
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // Only the scene document changes: the root entry is untouched.
    expect(planned.value.documents.map((document) => document.path)).toEqual(["compositions/scene-2.html"]);
    expect(planned.value.documents[0]!.expectedContentHash).toBe(hash("b".repeat(64)));
    expect(composition.calls).toHaveLength(1);
    expect(composition.calls[0]!.path).toBe("compositions/scene-2.html");
    const added = composition.calls[0]!.ops[0]!;
    expect(added.kind).toBe("addElement");
    const html = (added as { value: { html: string } }).value.html;
    // Scene-local zero, clamped to the host scene duration, next overlay track.
    expect(html).toContain('data-start="0"');
    expect(html).toContain('data-duration="4"');
    expect(html).toContain('data-track-index="1"');
    expect(html).toContain("data-catalog-provenance=");
  });

  it("rejects a new sub-frame catalog duration before applying composition ops", async () => {
    const composition = compositionPort();
    const planned = await planCatalogMountDocuments({
      ref,
      model,
      item: item({ durationSeconds: 2.55 }),
      mount: { kind: "new-scene", toIndex: 2 },
      entryHash: null,
      composition,
      now: () => new Date(),
    });
    expect(planned).toMatchObject({
      ok: false,
      error: {
        code: "insertion_rejected",
        error: { code: ErrorCode.TimingNotFrameAligned, field: "duration" },
      },
    });
    expect(composition.calls).toHaveLength(0);
  });

  it("refuses an unknown scene and a template mounted into a scene", async () => {
    expect(await planCatalogMountDocuments({
      ref, model, item: item(), mount: { kind: "into-scene", sceneId: "scene-9" },
      entryHash: null, composition: compositionPort(), now: () => new Date(),
    })).toEqual({ ok: false, error: { code: "scene_not_found", sceneId: "scene-9" } });

    expect(await planCatalogMountDocuments({
      ref, model, item: item({ kind: "template" }), mount: { kind: "into-scene", sceneId: "scene-2" },
      entryHash: null, composition: compositionPort(), now: () => new Date(),
    })).toEqual({ ok: false, error: { code: "mount_not_supported", kind: "template" } });
  });
});
