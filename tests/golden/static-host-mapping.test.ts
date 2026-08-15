import { cacheControlFor, mimeTypeFor, resolveAsset } from "@vidcom/cli";
import { describe, expect, it } from "vitest";

/**
 * The full request-to-asset mapping, written out rather than derived.
 *
 * Every row is a request a browser actually makes against the packaged host.
 * Listing them together is what makes a change visible: adjusting the resolver
 * to fix one row shows immediately if it moved another.
 */
const MAPPING = [
  { url: "/", asset: "index.html", mime: "text/html; charset=utf-8", cache: "no-store" },
  { url: "/index.html", asset: "index.html", mime: "text/html; charset=utf-8", cache: "no-store" },
  { url: "/settings", asset: "settings.html", mime: "text/html; charset=utf-8", cache: "no-store" },
  {
    url: "/projects/my-video",
    asset: "projects/__shell.html",
    mime: "text/html; charset=utf-8",
    cache: "no-store",
  },
  {
    url: "/projects/my-video.txt",
    asset: "projects/__shell.txt",
    mime: "text/plain; charset=utf-8",
    cache: "no-store",
  },
  {
    url: "/_next/static/chunks/main-abc123.js",
    asset: "_next/static/chunks/main-abc123.js",
    mime: "text/javascript; charset=utf-8",
    cache: "public, max-age=31536000, immutable",
  },
  {
    url: "/_next/static/css/app-abc123.css",
    asset: "_next/static/css/app-abc123.css",
    mime: "text/css; charset=utf-8",
    cache: "public, max-age=31536000, immutable",
  },
  { url: "/favicon.ico", asset: "favicon.ico", mime: "image/x-icon", cache: "public, max-age=31536000, immutable" },
] as const;

describe("packaged static host mapping", () => {
  it.each(MAPPING)("$url", ({ url, asset, mime, cache }) => {
    const resolved = resolveAsset(url);
    expect(resolved).not.toBeNull();
    if (!resolved) return;
    expect(resolved.assetPath).toBe(asset);
    expect(mimeTypeFor(resolved.assetPath)).toBe(mime);
    expect(cacheControlFor(resolved.cachePolicy)).toBe(cache);
  });

  it("labels an unplanned extension as a download rather than guessing", () => {
    // The pack holds only what the export wrote, so an unknown extension means
    // the build produced something nobody planned. Making the browser download
    // it is the safe way to be wrong.
    expect(mimeTypeFor("weird.bin")).toBe("application/octet-stream");
    expect(mimeTypeFor("noextension")).toBe("application/octet-stream");
  });

  it("matches extensions case-insensitively, as a filesystem may hand them over", () => {
    expect(mimeTypeFor("LOGO.PNG")).toBe("image/png");
  });

  it.each([
    "/../secrets",
    "/%2e%2e/secrets",
    "/%252e%252e/secrets",
    "/projects/../../etc/passwd",
  ])("refuses %s so it reaches the 404 path", (url) => {
    // Resolving to null is what the host turns into a 404; a traversal must not
    // find another manifest key instead.
    expect(resolveAsset(url)).toBeNull();
  });
});
