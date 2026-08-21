import type {
  CatalogInstallPrepareRequest,
  CatalogInstallPrepareResponse,
  CatalogItemDto,
  CatalogListResponse,
} from "@vidcom/contracts";

import type { ApiPath, ApiRequestInit } from "@/lib/api/services";

/**
 * Catalog rail view model (R7.1–7.6, R9.1–9.4c).
 *
 * Every decision the rail displays is computed here rather than inside JSX, so
 * the wording of a provenance badge, an empty state, a reinstall question or a
 * failure can be asserted in a node test. Nothing here invents catalog data: the
 * version, digest, listing source and staleness all come from the server, and an
 * unmanaged file is described as having no install record rather than being given
 * a made-up version.
 */

export type CatalogItemKind = CatalogItemDto["kind"];

export interface CatalogRailFilter {
  /** `all` means no `kind` parameter at all, which the server treats as no filter. */
  kind: CatalogItemKind | "all";
  tags: string[];
  query: string;
  category: string | null;
}

export const EMPTY_CATALOG_FILTER: CatalogRailFilter = {
  kind: "all",
  tags: [],
  query: "",
  category: null,
};

/** Builds the listing path; `kind` is applied before any text filter. */
export function catalogListPath(filter: CatalogRailFilter): ApiPath {
  const query = new URLSearchParams();
  if (filter.kind !== "all") query.set("kind", filter.kind);
  if (filter.category) query.set("category", filter.category);
  if (filter.tags.length > 0) query.set("tags", filter.tags.join(","));
  const trimmed = filter.query.trim();
  if (trimmed) query.set("q", trimmed);
  const search = query.toString();
  return (search ? `/api/v1/catalog?${search}` : "/api/v1/catalog") as ApiPath;
}

/**
 * Builds a prepare or execute request for one exact intent.
 *
 * The grant travels in the path and the body repeats the identical intent, so a
 * grant cannot be paired with a different install than the one it approved.
 */
export function catalogInstallRequest(
  projectId: string,
  intent: Omit<CatalogInstallPrepareRequest, "projectId">,
  grantId?: string,
): { path: ApiPath; init: ApiRequestInit } {
  const root = `/api/v1/projects/${encodeURIComponent(projectId)}/catalog-items/plans`;
  return {
    path: (grantId ? `${root}/${encodeURIComponent(grantId)}` : root) as ApiPath,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(intent),
    },
  };
}

export interface CatalogCompatibilityNotice {
  level: "blocked" | "unknown";
  message: string;
}

export interface CatalogItemBadges {
  source: CatalogListResponse["source"];
  stale: boolean;
  staleLabel: string | null;
  version: string;
  shortVersion: string;
  verification: "verified" | "on-install";
  verificationLabel: string;
  digest: string | null;
  shortDigest: string | null;
  compatibility: CatalogCompatibilityNotice | null;
}

function shortenVersion(version: string): string {
  const commit = /^git:([0-9a-f]{40})$/u.exec(version);
  return commit ? `git:${commit[1]!.slice(0, 7)}` : version;
}

/** Provenance, staleness, verification state and compatibility for one card. */
export function catalogItemBadges(
  item: CatalogItemDto,
  listing: Pick<CatalogListResponse, "source" | "stale">,
): CatalogItemBadges {
  const verified = item.materialization === "verified" && item.integrity !== null;
  const digest = verified ? item.integrity!.manifest : null;
  const warning = item.compatibilityWarning;
  return {
    source: listing.source,
    stale: listing.stale,
    staleLabel: listing.stale ? "Showing an older copy while it refreshes" : null,
    version: item.version,
    shortVersion: shortenVersion(item.version),
    verification: verified ? "verified" : "on-install",
    verificationLabel: verified
      ? "Contents verified"
      : "Contents are verified when you install",
    digest,
    shortDigest: digest ? digest.slice(0, 12) : null,
    compatibility: warning === null || warning.status === "compatible"
      ? null
      : warning.status === "incompatible"
        ? {
            level: "blocked",
            message: `Needs HyperFrames ${warning.required}; this build ships ${warning.runtime}.`,
          }
        : {
            level: "unknown",
            message: `Requires HyperFrames ${warning.required}, which cannot be checked.`,
          },
  };
}

export interface CatalogEmptyState {
  reason: "no-results" | "offline";
  message: string;
}

/**
 * Explains an empty rail with the reason it is actually empty.
 *
 * A bundled-only listing means the registry could not be reached, which is a
 * different problem from a filter that matched nothing, and the author is told
 * which one it is.
 */
export function catalogEmptyState(
  listing: CatalogListResponse,
  filter: CatalogRailFilter,
): CatalogEmptyState | null {
  if (listing.items.length > 0) return null;
  if (listing.source === "bundled") {
    return {
      reason: "offline",
      message: "Only bundled items are available right now; the registry could not be reached (offline).",
    };
  }
  const parts: string[] = [];
  if (filter.kind !== "all") parts.push(`kind ${filter.kind}`);
  if (filter.category) parts.push(`category ${filter.category}`);
  if (filter.tags.length > 0) parts.push(`tags ${filter.tags.join(", ")}`);
  const trimmed = filter.query.trim();
  if (trimmed) parts.push(`“${trimmed}”`);
  return {
    reason: "no-results",
    message: parts.length > 0
      ? `Nothing matches ${parts.join(" · ")}.`
      : "The catalog is empty.",
  };
}

export interface CatalogChoiceAction {
  policy: "reuse" | "replace" | "skip";
  label: string;
}

export interface CatalogChoicePrompt {
  title: string;
  description: string;
  existingVersionLabel: string;
  candidateVersionLabel: string;
  existingDigestLabel: string;
  candidateDigestLabel: string;
  actions: CatalogChoiceAction[];
}

const CHOICE_LABELS: Record<CatalogChoiceAction["policy"], string> = {
  reuse: "Reuse & mount",
  replace: "Replace",
  skip: "Skip",
};

/** Turns the server's question into exactly the choices it allows. */
export function catalogChoicePrompt(
  response: Extract<CatalogInstallPrepareResponse, { status: "choice_required" }>,
): CatalogChoicePrompt {
  const existingVersionLabel = response.existing.version ?? "unknown";
  const candidateVersionLabel = response.candidate.version;
  // An unmanaged file has no digest of ours to show; "unknown" is the truth.
  const existingDigestLabel = response.existing.integrity?.slice(0, 12) ?? "unknown";
  const candidateDigestLabel = response.candidate.integrity.slice(0, 12);
  const description = response.comparison === "identical"
    ? `This package is already installed at ${existingVersionLabel} (${existingDigestLabel}) with the same contents.`
      + " Reusing keeps those files and still adds a new mount."
    : response.comparison === "unmanaged"
      ? "These files already exist but have no install record, so their version cannot be known."
        + ` Replacing overwrites them with ${candidateVersionLabel} (${candidateDigestLabel}) and undo restores your files.`
      : `Installed ${existingVersionLabel} (${existingDigestLabel}), offered ${candidateVersionLabel} (${candidateDigestLabel}).`
        + " Replacing overwrites the installed files; undo restores them.";
  return {
    title: response.comparison === "identical" ? "Already installed" : "Files already exist",
    description,
    existingVersionLabel,
    candidateVersionLabel,
    existingDigestLabel,
    candidateDigestLabel,
    actions: response.choices.map((policy) => ({ policy, label: CHOICE_LABELS[policy] })),
  };
}

/**
 * Failure wording per error code.
 *
 * An integrity failure never borrows the offline wording: they have different
 * causes and different fixes, and conflating them hides a tampered package.
 */
export function catalogInstallFailureMessage(error: { code: string; message: string }): string {
  switch (error.code) {
    case "integrity_mismatch":
      return "This package does not match its digest, so nothing was installed.";
    case "download_unavailable":
      return "The package could not be downloaded; nothing was installed.";
    case "too_large":
      return "This package is too large to install.";
    case "write_conflict":
      return "The project changed while this install was prepared. Reload and try again.";
    case "approval_expired":
      return "The confirmation expired. Prepare the install again.";
    case "invariant_violated":
      return "This item cannot be mounted that way.";
    default:
      return error.message;
  }
}

/**
 * Which mounts the rail may offer for one item.
 *
 * A template is a whole scene, so it can only be appended; a block can also be
 * layered into the scene the author already has open. The rail never invents a
 * target the server would refuse.
 */
export function catalogMountOptions(
  item: CatalogItemDto,
  context: { sceneCount: number; selectedSceneId: string | null },
): Array<{ label: string; mount: CatalogInstallPrepareRequest["mount"] }> {
  const appended = {
    label: "Add as scene",
    mount: { kind: "new-scene" as const, toIndex: context.sceneCount },
  };
  if (item.kind !== "block" || context.selectedSceneId === null) return [appended];
  return [
    appended,
    {
      label: "Add into scene",
      mount: { kind: "into-scene" as const, sceneId: context.selectedSceneId },
    },
  ];
}

export type CatalogItemKindFilterValue = CatalogRailFilter["kind"];
