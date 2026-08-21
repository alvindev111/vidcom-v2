import {
  ErrorCode,
  PreviewCapabilityResponseSchema,
  ProjectParamsSchema,
  type ProjectId,
} from "@vidcom/contracts";
import { applyMutationInverse } from "@vidcom/core";
import { Hono, type Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";
import type { ProjectWriteRouteDependencies } from "./project-writes";
import {
  browserSessionId,
  requireAttachedStudio,
  studioSessionId,
  type StudioRouteDependencies,
} from "./studio-session";

function fail(code: ErrorCode, message: string): never {
  throw new HttpBoundaryError({ code, message });
}

function projectId(c: Context): ProjectId {
  const parsed = ProjectParamsSchema.safeParse({ id: c.req.param("id") });
  return parsed.success ? parsed.data.id as ProjectId : fail(ErrorCode.SchemaInvalid, "project id is invalid");
}

export function createHistoryRoutes(
  dependencies: StudioRouteDependencies & { writes: ProjectWriteRouteDependencies },
): Hono {
  const routes = new Hono();

  routes.post("/v1/projects/:id/history/session", (c) => {
    const id = projectId(c);
    const studioId = studioSessionId(c);
    const browserId = browserSessionId(dependencies, c);
    dependencies.history.attach(browserId, studioId, id);
    if (!dependencies.history.isAttached(browserId, studioId, id)) {
      fail(ErrorCode.SchemaInvalid, "studio session is already attached to another browser or project");
    }
    return c.body(null, 204);
  });

  routes.delete("/v1/projects/:id/history/session", (c) => {
    const id = projectId(c);
    const attached = requireAttachedStudio(dependencies, c, id);
    dependencies.previewCapabilities?.revoke({ projectId: id, ...attached });
    dependencies.history.detach(attached.browserSessionId, attached.studioSessionId, id);
    return c.body(null, 204);
  });

  routes.post("/v1/projects/:id/preview-capability", (c) => {
    const id = projectId(c);
    const attached = requireAttachedStudio(dependencies, c, id);
    if (!dependencies.previewCapabilities || !dependencies.previewOrigin) {
      fail(ErrorCode.StorageUnavailable, "preview capability service is unavailable");
    }
    const capability = dependencies.previewCapabilities.mint({ projectId: id, ...attached });
    return c.json(PreviewCapabilityResponseSchema.parse({
      ...capability,
      origin: dependencies.previewOrigin,
    }));
  });

  routes.get("/v1/projects/:id/history", (c) => {
    const id = projectId(c);
    const attached = requireAttachedStudio(dependencies, c, id);
    return c.json(dependencies.history.state(attached.studioSessionId, id));
  });

  const inverse = (direction: "undo" | "redo") => async (c: Context) => {
    const id = projectId(c);
    const attached = requireAttachedStudio(dependencies, c, id);
    const begun = dependencies.history.begin(attached.studioSessionId, id, direction);
    if (!begun.ok) throw new HttpBoundaryError(begun.error);
    const origin = {
      kind: "ui" as const,
      sessionId: attached.studioSessionId,
      label: direction === "undo" ? "Undo" : "Redo",
      historyAction: direction,
      historyOperation: { id: begun.value.operationId, targetReceiptId: begun.value.receipt.id },
    };
    try {
      const applied = await applyMutationInverse(dependencies.writes, {
        projectId: id,
        receipt: begun.value.receipt,
        direction,
      }, "user", origin);
      if (!applied.ok) throw new HttpBoundaryError(applied.error);
      return c.json({
        applied: direction,
        revision: applied.value.envelope.projectRevision,
        changeSeq: applied.value.envelope.changeSeq,
        state: dependencies.history.state(attached.studioSessionId, id),
      });
    } finally {
      dependencies.history.cancel(begun.value.operationId);
    }
  };

  routes.post("/v1/projects/:id/undo", inverse("undo"));
  routes.post("/v1/projects/:id/redo", inverse("redo"));
  return routes;
}
