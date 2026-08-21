"use client";

import * as React from "react";
import { Loader2Icon, PackageIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";

import type {
  CatalogInstallPrepareRequest,
  CatalogInstallPrepareResponse,
  CatalogInstallResponse,
  CatalogItemDto,
  CatalogListResponse,
} from "@vidcom/contracts";
import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api/services";
import {
  EMPTY_CATALOG_FILTER,
  catalogChoicePrompt,
  catalogEmptyState,
  catalogInstallFailureMessage,
  catalogInstallRequest,
  catalogItemBadges,
  catalogListPath,
  catalogMountOptions,
  type CatalogRailFilter,
} from "@/lib/studio/catalog-rail";
import type { ProjectChanged } from "@/lib/studio/preview-reload";
import { useStudioSession } from "./studio-session-context";

const KIND_CHIPS: ReadonlyArray<{ value: CatalogRailFilter["kind"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "template", label: "Templates" },
  { value: "block", label: "Blocks" },
];

interface PendingChoice {
  item: CatalogItemDto;
  /** The mount the author already chose; the retry repeats it exactly. */
  mount: CatalogInstallPrepareRequest["mount"];
  response: Extract<CatalogInstallPrepareResponse, { status: "choice_required" }>;
}

/**
 * Catalog rail: browse bundled templates and registry blocks, then install one.
 *
 * Every label, question and failure sentence comes from `catalog-rail.ts` so it
 * can be asserted without a browser. The rail never computes a digest, a plan or
 * a mount position of its own: it sends the same intent twice, once to prepare and
 * once to execute with the grant the server issued.
 */
export function CatalogRail({
  projectId,
  projectRevision,
  sceneCount,
  selectedSceneId = null,
  onProjectChanged,
  onSelectScene,
}: {
  projectId: string;
  projectRevision: number;
  sceneCount: number;
  /** Enables the block-into-scene target Design §5.17 allows. */
  selectedSceneId?: string | null;
  onProjectChanged: ProjectChanged;
  onSelectScene?: (sceneId: string) => void;
}) {
  const studio = useStudioSession();
  const [filter, setFilter] = React.useState<CatalogRailFilter>(EMPTY_CATALOG_FILTER);
  const [listing, setListing] = React.useState<CatalogListResponse | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [choice, setChoice] = React.useState<PendingChoice | null>(null);
  const [outcome, setOutcome] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetchApi(catalogListPath(filter));
        const body = await response.json() as CatalogListResponse & { error?: { message?: string } };
        if (cancelled) return;
        if (!response.ok) {
          setProblem(body.error?.message ?? "the catalog could not be read");
          return;
        }
        // Cleared here rather than before the request, so a re-filter never blanks
        // a live error before the replacement listing has actually arrived.
        setProblem(null);
        setListing(body);
      } catch {
        if (!cancelled) setProblem("the catalog could not be read");
      }
    })();
    return () => { cancelled = true; };
  }, [filter]);

  const install = React.useCallback(async (
    item: CatalogItemDto,
    mount: CatalogInstallPrepareRequest["mount"],
    existingPolicy?: "reuse" | "replace" | "skip",
  ) => {
    setBusy(item.name);
    setProblem(null);
    setOutcome(null);
    try {
      const intent = {
        name: item.name,
        version: item.version,
        mount,
        expectedRevision: projectRevision,
        ...(existingPolicy ? { existingPolicy } : {}),
      };
      const prepare = catalogInstallRequest(projectId, intent);
      const prepared = await fetchApi(prepare.path, studio.request(prepare.init));
      const preparedBody = await prepared.json() as CatalogInstallPrepareResponse
        & { error?: { code?: string; message?: string } };
      if (!prepared.ok) {
        setProblem(catalogInstallFailureMessage({
          code: preparedBody.error?.code ?? "unknown",
          message: preparedBody.error?.message ?? "the install could not be prepared",
        }));
        return;
      }
      if (preparedBody.status === "skipped") {
        setChoice(null);
        setOutcome("Skipped: nothing was installed and no mount was created.");
        return;
      }
      if (preparedBody.status === "choice_required") {
        setChoice({ item, mount, response: preparedBody });
        return;
      }
      setChoice(null);
      const execute = catalogInstallRequest(projectId, intent, preparedBody.grantId);
      const executed = await fetchApi(execute.path, studio.request(execute.init));
      const executedBody = await executed.json() as CatalogInstallResponse
        & { error?: { code?: string; message?: string } };
      if (!executed.ok) {
        setProblem(catalogInstallFailureMessage({
          code: executedBody.error?.code ?? "unknown",
          message: executedBody.error?.message ?? "the install failed",
        }));
        return;
      }
      setOutcome(executedBody.packageStatus === "reused"
        ? "Reused the files already in the project and created a new mount."
        : executedBody.packageStatus === "replaced"
          ? "Replaced the existing files and created a new mount. Undo restores them."
          : "Installed and mounted.");
      onProjectChanged(executedBody.changeSeq);
      if (executedBody.sceneId) onSelectScene?.(executedBody.sceneId);
    } catch {
      setProblem("the install could not be completed");
    } finally {
      setBusy(null);
    }
  }, [onProjectChanged, onSelectScene, projectId, projectRevision, studio]);

  const empty = listing ? catalogEmptyState(listing, filter) : null;
  const prompt = choice ? catalogChoicePrompt(choice.response) : null;

  return (
    <section className="flex flex-col gap-3" aria-label="Catalog">
      <div className="flex flex-wrap items-center gap-1.5">
        {KIND_CHIPS.map((chip) => (
          <Button
            key={chip.value}
            type="button"
            size="sm"
            variant={filter.kind === chip.value ? "default" : "outline"}
            aria-pressed={filter.kind === chip.value}
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => setFilter((current) => ({ ...current, kind: chip.value }))}
          >
            {chip.label}
          </Button>
        ))}
        <input
          type="search"
          value={filter.query}
          aria-label="Search the catalog"
          placeholder="Search"
          className="border-input h-7 min-w-24 flex-1 rounded-md border bg-transparent px-2 text-xs"
          onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
        />
      </div>

      {listing?.stale ? (
        <p className="text-muted-foreground text-xs" role="status">
          Showing an older copy while it refreshes.
        </p>
      ) : null}
      {problem ? <p className="text-destructive text-xs" role="alert">{problem}</p> : null}
      {outcome ? <p className="text-xs" role="status">{outcome}</p> : null}

      {prompt ? (
        <div className="border-border rounded-md border p-3" role="group" aria-label={prompt.title}>
          <p className="text-sm font-medium">{prompt.title}</p>
          <p className="text-muted-foreground mt-1 text-xs">{prompt.description}</p>
          <div className="mt-2 flex gap-2">
            {prompt.actions.map((action) => (
              <Button
                key={action.policy}
                type="button"
                size="sm"
                variant={action.policy === "skip" ? "outline" : "default"}
                className="h-7 text-xs"
                onClick={() => void install(choice!.item, choice!.mount, action.policy)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {empty ? (
        <p className="text-muted-foreground text-xs" role="status" data-catalog-empty={empty.reason}>
          {empty.message}
        </p>
      ) : null}

      <ul className="grid grid-cols-2 gap-2">
        {(listing?.items ?? []).map((item) => {
          const badges = catalogItemBadges(item, listing!);
          return (
            <li
              key={`${item.source.registry}:${item.name}`}
              className="border-border flex flex-col gap-1.5 rounded-md border p-2"
              data-catalog-item={item.name}
            >
              <div className="flex items-start justify-between gap-1">
                <span className="text-xs font-medium">{item.title}</span>
                <span className="text-muted-foreground text-[10px] uppercase">{item.kind}</span>
              </div>
              <span className="text-muted-foreground text-[11px]">{item.category}</span>
              <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-[10px]">
                <span data-catalog-source={badges.source}>{badges.source}</span>
                <span aria-hidden>·</span>
                <span>{badges.shortVersion}</span>
                {badges.verification === "verified" ? (
                  <span className="inline-flex items-center gap-0.5" title={badges.digest ?? undefined}>
                    <ShieldCheckIcon className="size-3" />
                    {badges.shortDigest}
                  </span>
                ) : (
                  <span>{badges.verificationLabel}</span>
                )}
              </div>
              {badges.compatibility ? (
                <p
                  className="text-destructive flex items-start gap-1 text-[11px]"
                  role="alert"
                  data-catalog-compatibility={badges.compatibility.level}
                >
                  <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
                  {badges.compatibility.message}
                </p>
              ) : null}
              <div className="mt-auto flex flex-wrap gap-1">
                {catalogMountOptions(item, { sceneCount, selectedSceneId }).map((option) => (
                  <Button
                    key={option.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={busy !== null}
                    onClick={() => void install(item, option.mount)}
                  >
                    {busy === item.name ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      <PackageIcon className="size-3" />
                    )}
                    {option.label}
                  </Button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
