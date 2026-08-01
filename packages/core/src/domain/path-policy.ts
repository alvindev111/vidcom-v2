import type { PathPurpose, PathRejection } from "../port/types";

const SOURCE_EXTENSIONS = new Set(["html", "css", "js", "mjs", "ts", "json", "md", "txt", "py", "svg"]);
const ASSET_EXTENSIONS = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "json",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "gif",
  "mp4",
  "webm",
  "mov",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "woff",
  "woff2",
  "ttf",
  "otf",
]);
const PROTECTED_FILES = new Set([
  "package.json",
  "agents.md",
  "claude.md",
  "hyperframes.json",
  "vidcom.json",
  "preview-settings.json",
]);
const BLOCKED_DIRECTORIES = new Set(["node_modules", ".git", ".hyperframes"]);
const WRITE_ASSET_ROOTS = ["assets/", "preview-assets/bgm/", "narration/", "snapshots/", "renders/"];
const READ_ASSET_ROOTS = ["assets/", "compositions/", "snapshots/", "narration/", "preview-assets/", "renders/"];

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function isGloballyBlocked(path: string): boolean {
  const segments = path.split("/");
  return segments.some(
    (segment) =>
      segment.startsWith(".") ||
      segment.toLowerCase().startsWith(".env") ||
      BLOCKED_DIRECTORIES.has(segment.toLowerCase()),
  );
}

/** Pure syntax validation for a project-relative path; this function performs no I/O. */
export function checkPathSyntax(path: string): PathRejection | null {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return { reason: "invalid_syntax" };
  }
  return null;
}

/** Pure allowlist validation for one path purpose; callers must run syntax validation first. */
export function checkPathPurpose(path: string, purpose: PathPurpose): PathRejection | null {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (isGloballyBlocked(lower) || name.startsWith(".env") || PROTECTED_FILES.has(name)) {
    if (purpose === "system-write" && ["vidcom.json", "preview-settings.json"].includes(lower)) {
      return null;
    }
    return { reason: "not_allowed_for_purpose" };
  }

  let allowed = false;
  switch (purpose) {
    case "read-source":
      allowed = SOURCE_EXTENSIONS.has(extension(lower));
      break;
    case "write-source":
      allowed = SOURCE_EXTENSIONS.has(extension(lower)) && !lower.startsWith("narration/");
      break;
    case "read-asset":
      allowed =
        (lower === "index.html" || READ_ASSET_ROOTS.some((root) => lower.startsWith(root))) &&
        ASSET_EXTENSIONS.has(extension(lower));
      break;
    case "write-asset":
      allowed = WRITE_ASSET_ROOTS.some((root) => lower.startsWith(root));
      break;
    case "system-write":
      allowed =
        lower === "vidcom.json" ||
        lower === "preview-settings.json" ||
        (lower.startsWith("narration/") && lower.endsWith(".json"));
      break;
  }
  return allowed ? null : { reason: "not_allowed_for_purpose" };
}

/** Pure path policy object that can be injected into filesystem adapters. */
export const pathPolicy = {
  checkSyntax: checkPathSyntax,
  checkPurpose: checkPathPurpose,
};
