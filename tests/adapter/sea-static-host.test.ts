import { cacheControlFor, resolveAsset } from "@vidcom/cli";
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
