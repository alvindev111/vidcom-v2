import {
  CatalogInstallExecuteRequestSchema,
  CatalogInstallPrepareRequestSchema,
  CatalogInstallPrepareResponseSchema,
  CatalogInstallResponseSchema,
  CatalogListQuerySchema,
  CatalogListResponseSchema,
  ErrorCode,
  ProjectParamsSchema,
  type DomainError,
  type ProjectId,
} from "@vidcom/contracts";
import {
  catalogItemDto,
  executeCatalogInstall,
  prepareCatalogInstall,
  type CatalogInstallDependencies,
  type CatalogInstallExecuteDependencies,
  type CatalogListFilter,
  type CatalogListing,
} from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";
import { studioWriteInvocation, type StudioRouteDependencies } from "./studio-session";

/**
 * Catalog listing and install routes (Design §7.12, §7.13a/b).
 *
 * The listing projection is deliberately lossy: no registry URL and no local
 * path leave the daemon, so a browser cannot turn a listing into a fetch target.
 * Install is the same two-phase exact-intent shape as destructive edits — prepare
 * requests a grant, the authenticated click issues it, and execute repeats the
 * identical intent — and every mutation carries a server-owned studio invocation.
 */

export interface CatalogRouteDependencies {
  catalog: { list(filter: CatalogListFilter): Promise<CatalogListing> };
  install: CatalogInstallExecuteDependencies;
  approval: {
    request(binding: never, summary: string): Promise<string>;
    issue(grantId: string, approver: "ui" | "cli", now?: Date): Promise<unknown>;
  };
  studio?: StudioRouteDependencies;
}

function fail(error: DomainError): never {
  throw new HttpBoundaryError(error);
}

function projectId(c: Context): ProjectId {
  const parsed = ProjectParamsSchema.safeParse({ id: c.req.param("id") });
  return parsed.success
    ? parsed.data.id as ProjectId
    : fail({ code: ErrorCode.SchemaInvalid, message: "project id is invalid", field: "id" });
}

export function createCatalogRoutes(dependencies: CatalogRouteDependencies): Hono {
  const routes = new Hono();

  routes.get("/v1/catalog", async (c) => {
    const query = c.req.query();
    const parsed = CatalogListQuerySchema.safeParse({
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.tags ? { tags: query.tags.split(",").filter(Boolean) } : {}),
      ...(query.q ? { query: query.q } : {}),
    });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "catalog filter is invalid" });
    const listing = await dependencies.catalog.list(parsed.data);
    return c.json(CatalogListResponseSchema.parse({
      items: listing.items.map(catalogItemDto),
      source: listing.source,
      stale: listing.stale,
    }));
  });

  routes.post("/v1/projects/:id/catalog-items/plans", async (c) => {
    const parsed = CatalogInstallPrepareRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "catalog install intent is invalid" });
    const id = projectId(c);
    // The attachment is validated before an approval request exists, so an
    // unattached tab cannot create grants.
    studioWriteInvocation(dependencies.studio, c, id, "Install catalog item");
    const prepared = await prepareCatalogInstall(
      dependencies.install as CatalogInstallDependencies,
      { projectId: id, ...parsed.data },
    );
    if (!prepared.ok) fail(prepared.error);
    if (prepared.value.status === "skipped") {
      return c.json(CatalogInstallPrepareResponseSchema.parse({ status: "skipped" }));
    }
    if (prepared.value.status === "choice_required") {
      const { comparison, choices, existing, candidate } = prepared.value.decision;
      return c.json(CatalogInstallPrepareResponseSchema.parse({
        status: "choice_required",
        comparison,
        choices,
        existing,
        candidate,
      }));
    }
    const { plan, binding } = prepared.value;
    const grantId = await dependencies.approval.request(
      binding as never,
      `Install ${parsed.data.name} ${parsed.data.version}`,
    );
    return c.json(CatalogInstallPrepareResponseSchema.parse({
      status: "ready",
      grantId,
      plan: {
        files: plan.files,
        directories: plan.directories,
        mountTarget: plan.mountTarget,
        expectedRevision: plan.expectedRevision,
        targetHashes: binding.targetHashes,
        planDigest: binding.planDigest,
      },
    }));
  });

  routes.post("/v1/projects/:id/catalog-items/plans/:grantId", async (c) => {
    const parsed = CatalogInstallExecuteRequestSchema.safeParse({
      ...(await c.req.json().catch(() => null) as Record<string, unknown> | null),
      grantId: c.req.param("grantId"),
    });
    if (!parsed.success) fail({ code: ErrorCode.SchemaInvalid, message: "catalog install intent is invalid" });
    const id = projectId(c);
    const invocation = studioWriteInvocation(dependencies.studio, c, id, "Install catalog item");
    const { grantId, ...intent } = parsed.data;
    // The authenticated click is the approval boundary: the requested grant is
    // issued here, then reserved inside the mutation against its exact binding.
    await dependencies.approval.issue(grantId, "ui");
    const executed = await executeCatalogInstall(
      dependencies.install,
      { intent: { projectId: id, ...intent }, grantId },
      "user",
      invocation as never,
    );
    if (!executed.ok) fail(executed.error);
    return c.json(CatalogInstallResponseSchema.parse({
      packageStatus: executed.value.packageStatus,
      files: executed.value.files.map((file) => ({ path: file.path, action: file.action })),
      provenance: executed.value.provenance,
      sceneId: executed.value.sceneId,
      revision: executed.value.envelope.projectRevision,
      diagnostics: executed.value.envelope.diagnostics,
      changeSeq: executed.value.envelope.changeSeq,
    }), 201);
  });

  return routes;
}
