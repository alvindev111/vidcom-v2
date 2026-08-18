import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ErrorCode, type ContentHash, type ProjectId, type RelPath } from "@vidcom/contracts";
import {
  applyFont,
  type AbsolutePath,
  type FontStyleRequest,
  type ProjectRef,
  type ResolvedPath,
} from "@vidcom/core";

const projectId = "project_apply_font" as ProjectId;
const ref: ProjectRef = {
  id: projectId,
  slug: "apply-font",
  root: "/workspace/apply-font" as AbsolutePath,
  entry: "index.html" as RelPath,
};
const fontPath = "assets/fonts/Local Font.woff2" as RelPath;
const fontHash = digest("font");
const origin = {
  kind: "ui", sessionId: "session", label: "Apply font", historyAction: "record", historyOperation: null,
} as const;

function digest(value: string): ContentHash {
  return `sha256:${createHash("sha256").update(value).digest("hex")}` as ContentHash;
}

function setup(options: { metadata?: { status: "ok"; kind: "font"; byteSize: number; family: string; style: string } | { status: "unknown"; byteSize: number; reason: string } } = {}) {
  const files = new Map<string, { content: string; contentHash: ContentHash }>([
    ["index.html", { content: "<html><head></head><body></body></html>", contentHash: digest("entry") }],
    ["compositions/linked.html", { content: "<html><head></head><body></body></html>", contentHash: digest("linked") }],
  ]);
  const applied: FontStyleRequest[] = [];
  const mutations: unknown[] = [];
  let probes = 0;
  const dependencies = {
    workspace: {
      async readProjectRef(id: ProjectId) { return id === projectId ? ref : null; },
      async resolve(_ref: ProjectRef, value: string) { return { ok: true as const, value: value as ResolvedPath }; },
      async readFile(value: ResolvedPath) { return files.get(value) ?? null; },
      async readHash(value: ResolvedPath) { return String(value) === fontPath ? fontHash : files.get(value)?.contentHash ?? null; },
    },
    composition: {
      async parseProject() {
        return {
          project: { id: projectId, slug: ref.slug, title: ref.slug, width: 1920, height: 1080, duration: 8, updatedAt: new Date(0).toISOString(), sceneCount: 2, revision: 0 },
          scenes: [
            { id: "inline", src: null, start: 0, duration: 4, trackIndex: 0, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
            { id: "linked", src: "compositions/linked.html", start: 4, duration: 4, trackIndex: 0, block: null, isTransition: false, media: [], script: [], narration: null, elements: [], unresolvedEffects: 0 },
          ],
          rootTrack: null,
          diagnostics: [],
          sources: [
            { path: ref.entry, contentHash: digest("entry"), byteSize: 1 },
            { path: "compositions/linked.html" as RelPath, contentHash: digest("linked"), byteSize: 1 },
          ],
          references: [],
        };
      },
    },
    probe: {
      async probeFont() {
        probes += 1;
        return { ok: true as const, value: options.metadata ?? {
          status: "ok" as const, kind: "font" as const, byteSize: 4, family: "Local Family", style: "Bold Italic",
        } };
      },
    },
    styles: {
      async apply(_source: string, request: FontStyleRequest) {
        applied.push(request);
        return { ok: true as const, value: "<html><head><style></style></head><body></body></html>" };
      },
    },
    authority: {
      async mutateSource(request: unknown) {
        mutations.push(request);
        return { ok: true as const, value: { projectRevision: 4, entityRevision: null, fileHashes: {}, diagnostics: [], changeSeq: 4 } };
      },
    },
  };
  return { dependencies, files, applied, mutations, probes: () => probes };
}

describe("applyFont", () => {
  it("applies project scope to the entry and binds the exact font as a history dependency", async () => {
    const value = setup();
    const result = await applyFont(value.dependencies, {
      projectId, fontPath, fontContentHash: fontHash, scope: { kind: "project" }, expectedContentHash: digest("entry"),
    }, "user", { origin, toolAudit: null });

    expect(result).toMatchObject({ ok: true, value: { family: "Local Family", style: "Bold Italic", path: "index.html" } });
    expect(value.applied).toEqual([{
      family: "Local Family", style: "Bold Italic", fontPath, target: { kind: "document" },
    }]);
    expect(value.mutations).toMatchObject([{
      origin,
      historyReadGuards: [{ path: fontPath, state: { kind: "file", contentHash: fontHash } }],
      steps: [{ kind: "write", path: "index.html", expectedContentHash: digest("entry") }],
    }]);
  });

  it("targets a linked scene document or an inline composition without trusting client metadata", async () => {
    const linked = setup();
    await applyFont(linked.dependencies, {
      projectId, fontPath, fontContentHash: fontHash, scope: { kind: "scene", sceneId: "linked" }, expectedContentHash: digest("linked"),
    }, "user", { origin, toolAudit: null });
    expect(linked.applied[0]).toMatchObject({ target: { kind: "document" } });
    expect(linked.mutations[0]).toMatchObject({ steps: [{ path: "compositions/linked.html" }] });

    const inline = setup();
    await applyFont(inline.dependencies, {
      projectId, fontPath, fontContentHash: fontHash, scope: { kind: "scene", sceneId: "inline" }, expectedContentHash: digest("entry"),
    }, "user", { origin, toolAudit: null });
    expect(inline.applied[0]).toMatchObject({ target: { kind: "composition", id: "inline" } });
    expect(inline.mutations[0]).toMatchObject({ steps: [{ path: "index.html" }] });
  });

  it("rejects stale font hashes, unreadable metadata and control characters before mutation", async () => {
    const stale = setup();
    const staleResult = await applyFont(stale.dependencies, {
      projectId, fontPath, fontContentHash: digest("stale"), scope: { kind: "project" }, expectedContentHash: digest("entry"),
    }, "user", { origin, toolAudit: null });
    expect(staleResult).toMatchObject({ ok: false, error: { code: ErrorCode.WriteConflict } });
    expect(stale.probes()).toBe(0);
    expect(stale.mutations).toHaveLength(0);

    const unknown = setup({ metadata: { status: "unknown", byteSize: 4, reason: "broken font" } });
    const unknownResult = await applyFont(unknown.dependencies, {
      projectId, fontPath, fontContentHash: fontHash, scope: { kind: "project" }, expectedContentHash: digest("entry"),
    }, "user", { origin, toolAudit: null });
    expect(unknownResult).toMatchObject({ ok: false, error: { code: ErrorCode.AssetNotAllowed, details: { reason: "broken font" } } });
    expect(unknown.mutations).toHaveLength(0);

    const control = setup({ metadata: { status: "ok", kind: "font", byteSize: 4, family: "Bad\nFamily", style: "Regular" } });
    const controlResult = await applyFont(control.dependencies, {
      projectId, fontPath, fontContentHash: fontHash, scope: { kind: "project" }, expectedContentHash: digest("entry"),
    }, "user", { origin, toolAudit: null });
    expect(controlResult).toMatchObject({ ok: false, error: { code: ErrorCode.AssetNotAllowed } });
    expect(control.applied).toHaveLength(0);
  });
});
