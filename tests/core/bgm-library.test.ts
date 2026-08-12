import { describe, expect, it } from "vitest";

import type { ContentHash, ProjectId, RelPath } from "@vidcom/contracts";
import { installBgm, ok, type AbsolutePath, type BgmDependencies, type ProjectRef } from "@vidcom/core";

describe("remote BGM installation", () => {
  it("freezes provider provenance in the machine library before one project mutation", async () => {
    const projectId = "project_bgm_remote" as ProjectId;
    const ref: ProjectRef = {
      id: projectId,
      slug: "bgm-remote",
      root: "C:/workspace/bgm-remote" as AbsolutePath,
      entry: "index.html" as RelPath,
    };
    const bytes = new Uint8Array([73, 68, 51, 4]);
    const hash = "sha256:remote" as ContentHash;
    const track = {
      providerId: "openverse",
      trackId: "track-1",
      title: "Calm score",
      creator: "Artist",
      durationSeconds: 90,
      extension: "mp3" as const,
      license: { kind: "cc-by" as const, holder: "Artist", url: "https://license.test/by", note: null },
      sourceUrl: "https://source.test/track-1",
      attribution: "Calm score by Artist, CC BY.",
      tags: ["calm", "instrumental"],
    };
    let cached: unknown;
    let uploaded: unknown;
    const dependencies = {
      workspace: { async readProjectRef() { return ref; } },
      composition: {},
      journal: {},
      authority: {
        async uploadBgm(request: unknown) {
          uploaded = request;
          return ok({ path: null, contentHash: hash, revision: 7, diagnostics: [] });
        },
      },
      bgmSynth: { render() { throw new Error("synth must not run"); } },
      bgmProviders: {
        async search() { return { tracks: [], providers: [] }; },
        async download() { return ok({ track, bytes }); },
      },
      bgmLibrary: {
        async list() { return []; },
        async hasShipped() { return false; },
        async shippedLicenses() { return {}; },
        async recordShippedLicense() {},
        async readShipped() { return null; },
        async read() { return null; },
        async add(input: unknown) {
          cached = input;
          return ok({
            alreadyPresent: false,
            entry: {
              id: "bgm_remote",
              name: "Calm score.mp3",
              source: "provider",
              bedId: null,
              durationSeconds: 89.5,
              byteSize: bytes.byteLength,
              contentHash: hash,
              license: track.license,
              provenance: {
                providerId: track.providerId,
                trackId: track.trackId,
                sourceUrl: track.sourceUrl,
                attribution: track.attribution,
              },
              addedAt: "2026-08-12T00:00:00.000Z",
            },
          });
        },
      },
      hashContent() { return hash; },
    } as unknown as BgmDependencies;

    const result = await installBgm(dependencies, {
      projectId,
      providerTrack: { providerId: "openverse", trackId: "track-1" },
      expectedRevision: 6,
    }, "agent");

    expect(result).toMatchObject({
      ok: true,
      value: {
        track: { name: "bgm_remote.mp3", path: "preview-assets/bgm/bgm_remote.mp3", durationSeconds: 89.5 },
        revision: 7,
      },
    });
    expect(cached).toMatchObject({
      source: "provider",
      license: { kind: "cc-by", holder: "Artist" },
      provenance: { providerId: "openverse", trackId: "track-1" },
    });
    expect(uploaded).toMatchObject({
      ref,
      name: "bgm_remote.mp3",
      path: "preview-assets/bgm/bgm_remote.mp3",
      bytes,
      expectedRevision: 6,
    });
  });
});
