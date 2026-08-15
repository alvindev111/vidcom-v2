import {
  PACK_ASSET,
  cacheControlFor,
  createSeaStaticAssetHost,
  mimeTypeFor,
  requestPath,
  resolveAsset,
} from "@vidcom/cli";
import type { FrontendManifestEntry, SeaAssetSource } from "@vidcom/cli";
import { describe, expect, it } from "vitest";

describe("sea static asset resolution", () => {
  it("serves the index for the root", () => {
    expect(resolveAsset("/")).toEqual({ assetPath: "index.html", cachePolicy: "no-store" });
  });

  it("sends every project to the one exported shell", () => {
    // The export renders a single file for the route and the client reads the
    // real slug from the address bar, so every project must arrive at the same
    // document.
    expect(resolveAsset("/projects/my-video")?.assetPath).toBe("projects/__shell.html");
    expect(resolveAsset("/projects/another-one")?.assetPath).toBe("projects/__shell.html");
  });

  it("sends the RSC payload to the shell's payload", () => {
    // Next fetches `<route>.txt` for client navigation; missing this makes
    // in-app navigation 404 while a full page load works.
    expect(resolveAsset("/projects/my-video.txt")?.assetPath).toBe("projects/__shell.txt");
  });

  it("caches build-hashed assets forever and documents never", () => {
    expect(resolveAsset("/_next/static/chunks/abc123.js")).toEqual({
      assetPath: "_next/static/chunks/abc123.js",
      cachePolicy: "immutable",
    });
    expect(resolveAsset("/projects/my-video")?.cachePolicy).toBe("no-store");
    expect(cacheControlFor("immutable")).toContain("immutable");
    expect(cacheControlFor("no-store")).toBe("no-store");
  });

  it("resolves an extensionless path to the document the export wrote", () => {
    expect(resolveAsset("/settings")?.assetPath).toBe("settings.html");
  });

  it.each([
    ["/../secrets", "a plain traversal"],
    ["/projects/../../etc/passwd", "a traversal through a route"],
    ["/%2e%2e/secrets", "an encoded traversal"],
    ["/%252e%252e/secrets", "a double-encoded traversal"],
    ["/a/./b", "a current-directory segment"],
  ])("refuses %s (%s)", (url) => {
    // The pack is read-only and has no directories to escape, but a traversal
    // that lands on another manifest key still serves a file nobody asked for,
    // and the manifest holds the entire frontend.
    expect(resolveAsset(url)).toBeNull();
  });

  it("refuses a path that is still encoded after one decode", () => {
    // Double-encoding exists here only to slip a separator past a check that
    // decodes once, so refusing beats decoding again.
    expect(resolveAsset("/%252fetc%252fpasswd")).toBeNull();
  });

  it("refuses backslashes and null bytes", () => {
    expect(resolveAsset("/a\\b")).toBeNull();
    expect(resolveAsset("/a%00b")).toBeNull();
  });

  it("ignores the query string when choosing an asset", () => {
    expect(resolveAsset("/projects/my-video?t=abc")?.assetPath).toBe("projects/__shell.html");
  });

  it("collapses repeated separators rather than inventing empty segments", () => {
    expect(resolveAsset("//projects///my-video")?.assetPath).toBe("projects/__shell.html");
  });
});

describe("sea static asset host", () => {
  const files: Record<string, string> = {
    "index.html": "<!doctype html><title>home</title>",
    "_next/static/chunk.js": "console.log(1);",
    "projects/__shell.html": "<!doctype html><title>shell</title>",
  };

  function embed(): SeaAssetSource {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const entries: FrontendManifestEntry[] = [];
    let offset = 0;
    for (const [assetPath, contents] of Object.entries(files)) {
      const bytes = encoder.encode(contents);
      entries.push({
        path: assetPath,
        offset,
        length: bytes.byteLength,
        sha256: "",
        mime: mimeTypeFor(assetPath),
        cachePolicy: resolveAsset(`/${assetPath}`)?.cachePolicy ?? "no-store",
      });
      chunks.push(bytes);
      offset += bytes.byteLength;
    }
    const pack = new Uint8Array(offset);
    let cursor = 0;
    for (const chunk of chunks) {
      pack.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    const manifest = encoder.encode(JSON.stringify({ entries }));
    return {
      getRawAsset(key: string): ArrayBuffer {
        const bytes = key === PACK_ASSET ? pack : manifest;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    };
  }

  async function get(url: string, method = "GET"): Promise<Response> {
    return createSeaStaticAssetHost(embed()).handle(new Request(url, { method }));
  }

  it("serves an asset out of the pack at its recorded offset", async () => {
    const response = await get("http://localhost:7777/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(files["index.html"]);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("takes the cache header from the manifest the build wrote", async () => {
    // The build derived it from this same resolver, so reading it back is not a
    // second decision that could disagree.
    expect((await get("http://localhost:7777/_next/static/chunk.js")).headers.get("cache-control"))
      .toBe("public, max-age=31536000, immutable");
    expect((await get("http://localhost:7777/")).headers.get("cache-control")).toBe("no-store");
  });

  it("sends a project route to the one exported shell", async () => {
    const response = await get("http://localhost:7777/projects/anything");
    expect(await response.text()).toBe(files["projects/__shell.html"]);
  });

  it("never sees a traversal, because the Request constructor already resolved it", async () => {
    // Written down rather than assumed, because it is the opposite of what the
    // resolver's own traversal tests suggest. WHATWG URL parsing resolves `..`
    // *and* its percent-encoded spelling while parsing, so both of these ask
    // the host for `/index.html` and get it.
    expect((await get("http://localhost:7777/_next/static/../../index.html")).status).toBe(200);
    expect((await get("http://localhost:7777/%2e%2e/index.html")).status).toBe(200);
    // Nothing escapes by doing so: the pack has no directories, and every key a
    // normalised path can land on is an asset the export published anyway. The
    // resolver keeps refusing traversal for callers that hand it a raw path,
    // which is what a `node:http` request line still is.
    expect(resolveAsset("/_next/static/../../index.html")).toBeNull();
  });

  it("does not read a leading double slash as a hostname", async () => {
    // The URL parser takes `//projects/anything` as an authority and swallows
    // the first segment, which is why the path is cut out of the URL rather
    // than parsed a second time.
    expect(requestPath("http://localhost:7777//projects/anything")).toBe("//projects/anything");
  });

  it("404s an asset the export never wrote", async () => {
    expect((await get("http://localhost:7777/missing.js")).status).toBe(404);
  });

  it("answers HEAD without a body and refuses to be written through", async () => {
    const head = await get("http://localhost:7777/", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(files["index.html"]?.length));
    expect(await head.text()).toBe("");

    const write = await get("http://localhost:7777/", "POST");
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET, HEAD");
  });

  it("has no way to write the pack out, not merely no reason to", async () => {
    // Extracting the frontend next to the executable would put a mutable copy
    // of the app on disk, which is the directory this whole design exists to
    // avoid. A module that cannot reach the filesystem cannot drift into it.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("packages/cli/src/sea-static-host.ts", "utf8");
    expect(source).not.toMatch(/from "node:fs/u);
  });

  it("refuses a manifest that points past the pack", () => {
    // A manifest and a pack from different runs produce exactly this, and the
    // honest moment to say so is before the first request rather than on
    // whichever page loads the truncated asset.
    const source = embed();
    const broken: SeaAssetSource = {
      getRawAsset(key: string): ArrayBuffer {
        if (key === PACK_ASSET) return new ArrayBuffer(4);
        return source.getRawAsset(key);
      },
    };
    expect(() => createSeaStaticAssetHost(broken)).toThrow(/outside the pack/u);
  });
});
