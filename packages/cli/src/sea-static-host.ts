export type CachePolicy = "no-store" | "immutable";

export interface AssetResolution {
  /** Key into the frontend manifest. */
  assetPath: string;
  cachePolicy: CachePolicy;
}

const IMMUTABLE_PREFIX = "/_next/static/";
const SHELL_SEGMENT = "__shell";

/**
 * Percent-decodes once and rejects anything that is still encoded.
 *
 * One pass, not a loop: a value that still contains `%` after decoding was
 * double-encoded, and double-encoding only exists here to smuggle a separator
 * past a check that decodes once. Refusing is the answer, not decoding again.
 */
function decodeOnce(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("%")) return null;
  return decoded;
}

/**
 * Maps a request path onto an embedded asset.
 *
 * Everything is served out of a read-only pack inside the binary, so there is
 * no directory to escape from — but a traversal that resolves to another
 * manifest key still reads a file the user did not ask for, and the manifest
 * holds the whole frontend. The check stays.
 *
 * `/projects/<slug>` and its RSC payload both resolve to the one shell that was
 * exported: the export renders a single file for the route and the client reads
 * the real slug from the address bar, so every project has to arrive at the
 * same document.
 */
export function resolveAsset(rawUrl: string): AssetResolution | null {
  // The raw path is inspected first. `new URL()` resolves `..` on the way in,
  // so anything checked after it has already been normalised — a traversal
  // would arrive here looking like an ordinary path.
  const rawPath = rawUrl.split("?", 1)[0]?.split("#", 1)[0] ?? "";
  const rawDecoded = decodeOnce(rawPath);
  if (rawDecoded === null) return null;
  if (rawDecoded.includes("\\") || rawDecoded.includes("\0")) return null;
  const rawSegments = rawDecoded.split("/").filter((segment) => segment.length > 0);
  // `.` and `..` are refused rather than normalised away: a request containing
  // them is not one the app produces, so honouring it would only ever serve
  // something the caller had to construct by hand.
  if (rawSegments.some((segment) => segment === "." || segment === "..")) return null;

  // Built from the decoded segments rather than from `new URL`. A path opening
  // with `//` is read as an authority by the URL parser, so `//projects/x`
  // would arrive with its first segment silently taken as a hostname.
  const normalised = `/${rawSegments.join("/")}`;
  const decoded = normalised;

  if (normalised === "/") return { assetPath: "index.html", cachePolicy: "no-store" };

  if (decoded.startsWith(IMMUTABLE_PREFIX)) {
    // Content-hashed by the build, so it can be cached forever. Anything else
    // that changes between releases must not be.
    return { assetPath: normalised.slice(1), cachePolicy: "immutable" };
  }

  const project = /^\/projects\/[^/]+$/u.test(normalised);
  if (project) {
    // Next fetches `<route>.txt` for client navigation; both spellings have to
    // reach the same shell or in-app navigation 404s while a reload works.
    const rsc = normalised.endsWith(".txt");
    return {
      assetPath: rsc ? `projects/${SHELL_SEGMENT}.txt` : `projects/${SHELL_SEGMENT}.html`,
      cachePolicy: "no-store",
    };
  }

  if (normalised.endsWith(".html") || normalised.endsWith(".txt")) {
    return { assetPath: normalised.slice(1), cachePolicy: "no-store" };
  }

  // Extensionless paths are documents; the export wrote them as `.html`.
  if (!normalised.slice(1).includes(".")) {
    return { assetPath: `${normalised.slice(1)}.html`, cachePolicy: "no-store" };
  }

  return { assetPath: normalised.slice(1), cachePolicy: "immutable" };
}

/** Header value for a resolved asset. */
export function cacheControlFor(policy: CachePolicy): string {
  return policy === "immutable"
    ? "public, max-age=31536000, immutable"
    : "no-store";
}

/**
 * MIME type for an embedded asset, from its extension.
 *
 * A closed table rather than a lookup library: the pack only ever contains what
 * the export wrote, so an extension outside this list means the build produced
 * something nobody planned for. `application/octet-stream` makes a browser
 * download it instead of running it, which is the safe way to be wrong.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

export function mimeTypeFor(assetPath: string): string {
  const dot = assetPath.lastIndexOf(".");
  const extension = dot === -1 ? "" : assetPath.slice(dot).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

export interface FrontendManifestEntry {
  path: string;
  offset: number;
  length: number;
  sha256: string;
  mime: string;
  cachePolicy: CachePolicy;
}

/** The two blobs the build embeds, addressed by the names it wrote them under. */
export const MANIFEST_ASSET = "frontend-manifest.json";
export const PACK_ASSET = "frontend.pack";

/**
 * Reads an embedded asset.
 *
 * A seam rather than a direct `node:sea` call: the host has to be exercised
 * outside a packaged executable, and a test that can only run inside one is a
 * test nobody runs.
 */
export interface SeaAssetSource {
  getRawAsset(key: string): ArrayBuffer;
}

export interface SeaStaticAssetHost {
  handle(request: Request): Response;
}

/**
 * Takes the path out of an absolute request URL by cutting, not by parsing.
 *
 * `new URL()` is avoided for the reason `resolveAsset` avoids it: a path
 * opening with `//` is read as an authority, so `//projects/x` would arrive
 * with its first segment silently taken as a hostname. Percent-encoding is
 * left exactly as it came in — the resolver decodes once and refuses anything
 * still encoded after that, which is where an encoded traversal is caught.
 *
 * A literal `..` never reaches here: the Request constructor resolves it while
 * parsing the URL, long before this runs. That is the runtime's behaviour, not
 * a guarantee this host provides, which is why the resolver still refuses `..`
 * for callers that hand it a raw path.
 */
export function requestPath(url: string): string {
  const scheme = url.indexOf("://");
  const afterAuthority = scheme === -1 ? url : url.slice(scheme + 3);
  const slash = afterAuthority.indexOf("/");
  return slash === -1 ? "/" : afterAuthority.slice(slash);
}

function parseManifest(source: SeaAssetSource, packBytes: number): Map<string, FrontendManifestEntry> {
  const raw = new TextDecoder().decode(new Uint8Array(source.getRawAsset(MANIFEST_ASSET)));
  const parsed = JSON.parse(raw) as { entries?: FrontendManifestEntry[] };
  const entries = parsed.entries ?? [];
  if (entries.length === 0) throw new Error("frontend manifest is empty");

  const byPath = new Map<string, FrontendManifestEntry>();
  for (const entry of entries) {
    // Checked once at start-up rather than per request. An entry reaching past
    // the pack is a build that produced a manifest and a pack from different
    // runs, and the honest moment to say so is before the first request, not on
    // whichever page happens to load the truncated asset.
    if (entry.offset < 0 || entry.length < 0 || entry.offset + entry.length > packBytes) {
      throw new Error(`frontend manifest entry is outside the pack: ${entry.path}`);
    }
    byPath.set(entry.path, entry);
  }
  return byPath;
}

/**
 * Serves the exported frontend out of the executable.
 *
 * The pack is never written to disk and never copied: each response body is a
 * view onto the embedded bytes. Copying would mean holding a second full
 * frontend in memory, and writing it out would put a mutable copy of the app
 * next to the artifact, which is exactly the directory this design exists to
 * avoid.
 */
export function createSeaStaticAssetHost(source: SeaAssetSource): SeaStaticAssetHost {
  const pack = new Uint8Array(source.getRawAsset(PACK_ASSET));
  const entries = parseManifest(source, pack.byteLength);

  return {
    handle(request: Request): Response {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
      }

      const resolution = resolveAsset(requestPath(request.url));
      const entry = resolution === null ? undefined : entries.get(resolution.assetPath);
      if (entry === undefined) return new Response(null, { status: 404 });

      const headers = {
        "content-type": entry.mime,
        "content-length": String(entry.length),
        // The manifest carries the policy the build derived from this same
        // resolver, so the two cannot drift; reading it back is not a second
        // decision.
        "cache-control": cacheControlFor(entry.cachePolicy),
      };
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      return new Response(pack.subarray(entry.offset, entry.offset + entry.length), {
        status: 200,
        headers,
      });
    },
  };
}
