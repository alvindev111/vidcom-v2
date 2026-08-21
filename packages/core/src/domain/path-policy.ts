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
const STATE_WRITE_PATHS = [
  ".vidcom/context/", ".vidcom/logs/", ".vidcom/jobs/", ".vidcom/revisions/", ".vidcom/cache/",
];
const WORKSPACE_AGENT_FILES = new Set(["agents.md", "claude.md", "agents.vidcom.md", "claude.vidcom.md"]);
const WORKSPACE_AGENT_ROOTS = [".agents/skills/", ".claude/skills/"];

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
  if (lower.split("/").some((segment) => segment.startsWith(".env"))) {
    return { reason: "not_allowed_for_purpose" };
  }
  if (purpose === "state-write" && lower === ".vidcom/.gitignore") return null;
  if (purpose === "state-write" && isStateWritePath(lower) && !blockedBelowOwnedRoot(lower, 1)) return null;
  if (purpose === "workspace-agent-kit" && isWorkspaceAgentPath(lower) && !blockedBelowOwnedRoot(lower, 1)) return null;
  if (isGloballyBlocked(lower) || name.startsWith(".env") || PROTECTED_FILES.has(name)) {
    if (purpose === "system-write" && ["vidcom.json", "preview-settings.json"].includes(lower)) {
      return null;
    }
    return { reason: "not_allowed_for_purpose" };
  }

  let allowed = false;
  switch (purpose) {
    case "authored-write":
      allowed = true;
      break;
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
    case "read-package-target":
      // Catalog manifests may contain authored binary targets. This purpose
      // still passes the global hidden/protected checks above and grants no
      // browser-serving capability.
      allowed = true;
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
    case "state-write":
    case "workspace-agent-kit":
      allowed = false;
      break;
  }
  return allowed ? null : { reason: "not_allowed_for_purpose" };
}

function isStateWritePath(path: string): boolean {
  return path === ".vidcom/.gitignore"
    || path === ".vidcom/state.json"
    || STATE_WRITE_PATHS.some((root) => path === root.slice(0, -1) || path.startsWith(root));
}

function isWorkspaceAgentPath(path: string): boolean {
  return WORKSPACE_AGENT_FILES.has(path) || WORKSPACE_AGENT_ROOTS.some((root) => path.startsWith(root));
}

function blockedBelowOwnedRoot(path: string, ignoredSegments: number): boolean {
  return path.split("/").slice(ignoredSegments).some(
    (segment) => segment.startsWith(".") || BLOCKED_DIRECTORIES.has(segment),
  );
}

/** Pure path policy object that can be injected into filesystem adapters. */
export const pathPolicy = {
  checkSyntax: checkPathSyntax,
  checkPurpose: checkPathPurpose,
};
