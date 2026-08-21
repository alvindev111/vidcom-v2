// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  assetKindFromName,
  entryMutationRequest,
  startAssetUpload,
} from "@/lib/studio/asset-manager";

class FakeXhr {
  static latest: FakeXhr | null = null;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  status = 201;
  responseText = JSON.stringify({ path: "assets/photo.png", changeSeq: 4 });
  withCredentials = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = "";
  url = "";
  body: unknown = null;
  headers = new Map<string, string>();
  aborted = false;

  constructor() { FakeXhr.latest = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); }
  send(body: unknown) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
}

describe("asset manager requests", () => {
  it("classifies only the approved extension allowlists", () => {
    expect(assetKindFromName("PHOTO.PNG")).toBe("image");
    expect(assetKindFromName("voice.wav")).toBe("audio");
    expect(assetKindFromName("clip.mov")).toBe("video");
    expect(assetKindFromName("local.woff2")).toBe("font");
    expect(assetKindFromName("script.js")).toBeNull();
  });

  it("builds strict CRUD requests without deriving hashes in UI", () => {
    expect(entryMutationRequest("p 1", "create", {
      path: "assets/new folder", kind: "folder", expectedRevision: 3,
    })).toEqual({
      path: "/api/v1/projects/p%201/entries",
      init: expect.objectContaining({ method: "POST", body: JSON.stringify({
        path: "assets/new folder", kind: "folder", expectedRevision: 3,
      }) }),
    });
  });

  it("sends the raw file with session credentials, bounded progress and a real abort", async () => {
    const file = { name: "photo one.png", size: 100 } as File;
    const progress: number[] = [];
    const upload = startAssetUpload({
      projectId: "p 1", file, expectedRevision: 3,
      requestInit: { headers: { "x-vidcom-studio-session": "studio" } },
      onProgress: (value) => progress.push(value),
    }, FakeXhr as never);
    const xhr = FakeXhr.latest!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toContain("/api/v1/projects/p%201/assets?kind=image&filename=photo+one.png&expectedRevision=3");
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers.get("content-type")).toBe("application/octet-stream");
    expect(xhr.headers.get("x-vidcom-studio-session")).toBe("studio");
    expect(xhr.body).toBe(file);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    xhr.onload?.();
    await expect(upload.promise).resolves.toMatchObject({ path: "assets/photo.png", changeSeq: 4 });
    expect(progress).toEqual([0, 45, 90, 100]);

    const cancelled = startAssetUpload({
      projectId: "p", file, expectedRevision: 3, requestInit: {}, onProgress() {},
    }, FakeXhr as never);
    cancelled.cancel();
    expect(FakeXhr.latest?.aborted).toBe(true);
    await expect(cancelled.promise).rejects.toThrow("cancelled");
  });
});
