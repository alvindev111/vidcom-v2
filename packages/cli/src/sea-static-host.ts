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
