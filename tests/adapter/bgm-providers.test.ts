import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  BgmProviderError,
  BgmProviderRegistry,
  CcMixterBgmProvider,
  expandBgmMood,
  fetchBgmResponse,
  OpenverseBgmProvider,
  readBgmAudio,
  readBgmJson,
  type BgmProviderAdapter,
} from "@vidcom/adapter";
import {
  BgmProviderProvenanceSchema,
  BgmProviderTrackSchema,
  VerifiedBgmLicenseSchema,
  type BgmProviderTrack,
} from "@vidcom/contracts";

const mp3 = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0]);

function track(overrides: Partial<BgmProviderTrack> = {}): BgmProviderTrack {
  return {
    providerId: "secondary",
    trackId: "track-1",
    title: "Calm focus",
    creator: "Composer",
    durationSeconds: 90,
    extension: "mp3",
    license: { kind: "cc-by", holder: "Composer", url: "https://license.test/by", note: null },
    sourceUrl: "https://music.test/tracks/1",
    attribution: "Calm focus by Composer, CC BY.",
    tags: ["calm", "instrumental"],
    ...overrides,
  };
}

const publicDns = async () => ["8.8.8.8"];

type FakeLookup = (
  hostname: string,
  options: { all: boolean; family: number },
  callback: (error: Error | null, address: string) => void,
) => void;

function fakeHttpsResponse(body: unknown, connected: string[], statusCode = 200) {
  return ((url: URL, options: { lookup: FakeLookup }, onResponse: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => {
      options.lookup(url.hostname, { all: false, family: 0 }, (
        error: Error | null,
        address: string,
      ) => {
        if (error) {
          request.emit("error", error);
          return;
        }
        connected.push(address);
        const response = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
        Object.assign(response, {
          statusCode,
          headers: { "content-type": "application/json" },
        });
        onResponse(response);
      });
    };
    return request;
  }) as unknown as typeof import("node:https").request;
}

function openverseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "open-track",
    title: "Neutral ambience",
    foreign_landing_url: "https://source.test/open-track",
    url: "https://audio.test/open-track.mp3",
    creator: "Open Artist",
    license: "by",
    license_url: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Neutral ambience by Open Artist, CC BY 4.0.",
    duration: 45_000,
    filesize: mp3.byteLength,
    filetype: "mp3",
    tags: [{ name: "ambient" }, { name: "instrumental" }],
    ...overrides,
  };
}

describe("remote BGM providers", () => {
  it("expands common Vietnamese direction into stable mood search terms", () => {
    expect(expandBgmMood("êm dịu, tập trung")).toContain("calm gentle peaceful relaxing");
    expect(expandBgmMood("êm dịu, tập trung")).toContain("focused professional technology");
    expect(expandBgmMood("khác lạ")).toBe("khác lạ");
  });
  it("ranks Openverse by mood, excludes vocals, revalidates and downloads exact bytes", async () => {
    const calm = openverseRow({
      id: "calm-track",
      title: "Calm focused background",
      url: "https://audio.test/calm-track.mp3",
      tags: [{ name: "calm" }, { name: "focused" }, { name: "instrumental" }],
    });
    const vocal = openverseRow({ id: "vocal-track", tags: [{ name: "female_vocals" }] });
    const fetched: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === "https://audio.test/open-track.mp3" || url === "https://audio.test/calm-track.mp3") {
        return new Response(mp3, { headers: { "content-type": "audio/mpeg" } });
      }
      if (url.includes("/calm-track/")) return Response.json(calm);
      return Response.json({ results: [openverseRow(), calm, vocal] });
    }) as typeof globalThis.fetch;
    const provider = new OpenverseBgmProvider({ fetch, resolveHost: publicDns });

    const results = await provider.search({ mood: "calm focused", limit: 3 });
    expect(results.map(({ trackId }) => trackId)).toEqual(["calm-track", "open-track"]);
    expect(results[0]).toMatchObject({
      durationSeconds: 45,
      license: { kind: "cc-by", holder: "Open Artist" },
    });

    const downloaded = await provider.download("calm-track");
    expect(downloaded.track.trackId).toBe("calm-track");
    expect(downloaded.bytes).toEqual(mp3);
    expect(fetched.at(-1)).toBe("https://audio.test/calm-track.mp3");
  });

  it("parses attribution-only ccMixter tracks and rejects vocal-tagged candidates", async () => {
    const row = {
      upload_id: 42,
      upload_name: "Quiet machinery",
      user_real_name: "Mixer",
      file_page_url: "https://ccmixter.test/files/mixer/42",
      license_url: "http://creativecommons.org/licenses/by/4.0/",
      upload_tags: "calm,instrumental,background",
      files: [{
        file_name: "quiet.mp3",
        file_rawsize: mp3.byteLength,
        download_url: "https://audio.test/quiet.mp3",
        file_format_info: { "default-ext": "mp3", ps: "1:30" },
      }],
    };
    const fetch = (async (input: RequestInfo | URL) => String(input) === "https://audio.test/quiet.mp3"
      ? new Response(mp3, { headers: { "content-type": "audio/mpeg" } })
      : Response.json([row])) as typeof globalThis.fetch;
    const provider = new CcMixterBgmProvider({ fetch, resolveHost: publicDns });

    await expect(provider.search({ mood: "calm", limit: 2 })).resolves.toMatchObject([{
      providerId: "ccmixter",
      trackId: "42",
      durationSeconds: 90,
      license: { kind: "cc-by", holder: "Mixer" },
    }]);
    await expect(provider.download("42")).resolves.toMatchObject({ bytes: mp3 });
  });

  it("isolates a failed provider, interleaves healthy results, and never substitutes downloads", async () => {
    const unavailable: BgmProviderAdapter = {
      id: "primary",
      async search() { throw new BgmProviderError("primary rate limited"); },
      async download() { throw new Error("must not run"); },
    };
    const selected = track();
    const healthy: BgmProviderAdapter = {
      id: "secondary",
      async search() { return [selected]; },
      async download(trackId) {
        expect(trackId).toBe("track-1");
        return { track: selected, bytes: mp3 };
      },
    };
    const registry = new BgmProviderRegistry([unavailable, healthy]);
    await expect(registry.search({ mood: "calm", limit: 4 })).resolves.toEqual({
      tracks: [selected],
      providers: [
        { providerId: "primary", status: "unavailable", resultCount: 0, message: "primary rate limited" },
        { providerId: "secondary", status: "ok", resultCount: 1, message: null },
      ],
    });
    await expect(registry.download({ providerId: "secondary", trackId: "track-1" }))
      .resolves.toMatchObject({ ok: true, value: { track: selected, bytes: mp3 } });
    await expect(registry.download({ providerId: "missing", trackId: "track-1" }))
      .resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("reports every failed provider and preserves the offline fallback path", async () => {
    const failed = (id: string): BgmProviderAdapter => ({
      id,
      async search() { throw new BgmProviderError(`${id} unavailable`); },
      async download() { throw new Error("unused"); },
    });
    await expect(new BgmProviderRegistry([failed("one"), failed("two")])
      .search({ mood: "calm", limit: 4 })).resolves.toEqual({
      tracks: [],
      providers: [
        { providerId: "one", status: "unavailable", resultCount: 0, message: "one unavailable" },
        { providerId: "two", status: "unavailable", resultCount: 0, message: "two unavailable" },
      ],
    });
  });

  it("rejects adapter identity mismatches at the registry boundary", async () => {
    const mismatched: BgmProviderAdapter = {
      id: "secondary",
      async search() { return [track({ providerId: "impostor" })]; },
      async download() { return { track: track({ trackId: "another-track" }), bytes: mp3 }; },
    };
    const registry = new BgmProviderRegistry([mismatched]);
    await expect(registry.search({ mood: "calm", limit: 2 })).resolves.toMatchObject({
      tracks: [], providers: [{ providerId: "secondary", status: "unavailable", message: expect.stringMatching(/mismatched/u) }],
    });
    await expect(registry.download({ providerId: "secondary", trackId: "track-1" }))
      .resolves.toMatchObject({ ok: false, error: { code: "download_unavailable" } });
  });

  it("rejects provider records whose licence is not in the remote open-licence allowlist", async () => {
    const invalid: BgmProviderAdapter = {
      id: "secondary",
      async search() {
        return [track({ license: { kind: "unknown", holder: null, url: null, note: null } })];
      },
      async download() { throw new Error("unused"); },
    };
    await expect(new BgmProviderRegistry([invalid]).search({ mood: "calm", limit: 1 }))
      .resolves.toMatchObject({
        tracks: [],
        providers: [{ providerId: "secondary", status: "unavailable", message: expect.stringMatching(/invalid/u) }],
      });
  });

  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:c0a8:1",
    "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b::c0a8:1",
    "64:ff9b:1::7f00:1",
    "2002:c0a8:0101::1",
    "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
  ])(
    "blocks provider URLs resolving to %s before fetch",
    async (address) => {
      let fetched = false;
      const provider = new OpenverseBgmProvider({
        resolveHost: async () => [address],
        fetch: (async () => {
          fetched = true;
          return Response.json({ results: [] });
        }) as typeof globalThis.fetch,
      });
      await expect(provider.search({ mood: "calm", limit: 1 })).rejects.toThrow(/non-public/u);
      expect(fetched).toBe(false);
    },
  );

  it("rechecks every redirect and blocks a public-to-loopback hop", async () => {
    let calls = 0;
    const provider = new OpenverseBgmProvider({
      resolveHost: async (hostname) => hostname === "api.openverse.org" ? ["8.8.8.8"] : ["127.0.0.1"],
      fetch: (async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "https://localhost/private" } });
      }) as typeof globalThis.fetch,
    });
    await expect(provider.search({ mood: "calm", limit: 1 })).rejects.toThrow(/non-public/u);
    expect(calls).toBe(1);
  });

  it("pins the connection-time DNS result and rejects a rebinding result", async () => {
    const connected: string[] = [];
    let resolutions = 0;
    const provider = new OpenverseBgmProvider({
      resolveHost: async () => [++resolutions === 1 ? "8.8.8.8" : "8.8.4.4"],
      requestHttps: fakeHttpsResponse({ results: [] }, connected),
    });
    await expect(provider.search({ mood: "calm", limit: 1 })).resolves.toEqual([]);
    expect(connected).toEqual(["8.8.4.4"]);

    resolutions = 0;
    const rebound = new OpenverseBgmProvider({
      resolveHost: async () => [++resolutions === 1 ? "8.8.8.8" : "127.0.0.1"],
      requestHttps: fakeHttpsResponse({ results: [] }, connected),
    });
    await expect(rebound.search({ mood: "calm", limit: 1 })).rejects.toThrow(/non-public/u);
    expect(connected).toEqual(["8.8.4.4"]);
  });

  it.each([204, 304])("handles an empty-body HTTP %s without throwing outside the request promise", async (status) => {
    const provider = new OpenverseBgmProvider({
      resolveHost: async () => ["8.8.8.8"],
      requestHttps: fakeHttpsResponse(null, [], status),
    });
    await expect(provider.search({ mood: "calm", limit: 1 })).rejects.toBeInstanceOf(BgmProviderError);
  });

  it("bounds provider JSON even when the response is streamed without a content length", async () => {
    const provider = new OpenverseBgmProvider({
      resolveHost: publicDns,
      fetch: (async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1_048_577));
          controller.close();
        },
      }))) as typeof globalThis.fetch,
    });
    await expect(provider.search({ mood: "calm", limit: 1 })).rejects.toThrow(/too large/u);
  });

  it("cancels response bodies rejected before they can be consumed", async () => {
    let httpCancelled = false;
    const httpResponse = new Response(new ReadableStream({
      cancel() { httpCancelled = true; },
    }), { status: 500 });
    await expect(fetchBgmResponse(new URL("https://provider.test/search"), {
      resolveHost: publicDns,
      fetch: (async () => httpResponse) as typeof globalThis.fetch,
    })).rejects.toThrow(/HTTP 500/u);
    expect(httpCancelled).toBe(true);

    let jsonCancelled = false;
    const jsonResponse = new Response(new ReadableStream({
      cancel() { jsonCancelled = true; },
    }), { headers: { "content-length": "1048577" } });
    await expect(readBgmJson(jsonResponse, "invalid JSON")).rejects.toThrow(/too large/u);
    expect(jsonCancelled).toBe(true);

    let audioCancelled = false;
    const audioResponse = new Response(new ReadableStream({
      cancel() { audioCancelled = true; },
    }), { headers: { "content-type": "text/html" } });
    await expect(readBgmAudio(new URL("https://provider.test/not-audio.mp3"), "mp3", {
      resolveHost: publicDns,
      fetch: (async () => audioResponse) as typeof globalThis.fetch,
    })).rejects.toThrow(/non-audio/u);
    expect(audioCancelled).toBe(true);
  });

  it("requires attribution facts for CC BY instead of inventing a licence", () => {
    expect(VerifiedBgmLicenseSchema.safeParse({ kind: "cc-by", holder: null, url: null, note: null }).success).toBe(false);
    expect(VerifiedBgmLicenseSchema.safeParse({ kind: "cc-by", holder: "Artist", url: "", note: null }).success).toBe(false);
    expect(VerifiedBgmLicenseSchema.safeParse({ kind: "cc-by", holder: "Artist", url: "n/a", note: null }).success).toBe(false);
    expect(VerifiedBgmLicenseSchema.safeParse({
      kind: "cc-by", holder: "Artist", url: "https://source.test/license", note: null,
    }).success).toBe(true);
    expect(VerifiedBgmLicenseSchema.safeParse({
      kind: "unknown", holder: null, url: null, note: null,
    }).success).toBe(false);
  });

  it("accepts only web provenance URLs for remote provider records", () => {
    expect(BgmProviderProvenanceSchema.safeParse({
      providerId: "openverse",
      trackId: "track-1",
      sourceUrl: "file:///tmp/music.mp3",
      attribution: "Track by Artist.",
    }).success).toBe(false);
    expect(BgmProviderTrackSchema.safeParse(track({ sourceUrl: "ftp://music.test/track-1" })).success).toBe(false);
    expect(BgmProviderTrackSchema.safeParse(track({ sourceUrl: "https://music.test/track-1" })).success).toBe(true);
  });
});
