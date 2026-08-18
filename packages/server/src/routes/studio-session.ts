import { ErrorCode, StudioSessionIdSchema, type ProjectId } from "@vidcom/contracts";
import { ignoredMutationOriginForActor, type WriteInvocation } from "@vidcom/core";
import type { Context } from "hono";

import { HttpBoundaryError } from "../middleware/error-mapper";
import type { MutationHistory } from "../service/mutation-history";

export const STUDIO_SESSION_HEADER = "x-vidcom-studio-session";

export interface StudioRouteDependencies {
  history: MutationHistory;
  browserSessionId(request: Request): string | undefined;
}

function fail(code: ErrorCode, message: string, field?: string): never {
  throw new HttpBoundaryError({ code, message, ...(field === undefined ? {} : { field }) });
}

export function studioSessionId(c: Context): string {
  const raw = c.req.header(STUDIO_SESSION_HEADER);
  if (raw === undefined) fail(ErrorCode.PreconditionRequired, "studio session header is required", STUDIO_SESSION_HEADER);
  const parsed = StudioSessionIdSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : fail(ErrorCode.SchemaInvalid, "studio session header is invalid", STUDIO_SESSION_HEADER);
}

export function browserSessionId(dependencies: StudioRouteDependencies, c: Context): string {
  return dependencies.browserSessionId(c.req.raw)
    ?? fail(ErrorCode.AuthRequired, "authenticated browser session is unavailable");
}

export function requireAttachedStudio(
  dependencies: StudioRouteDependencies,
  c: Context,
  projectId: ProjectId,
): { browserSessionId: string; studioSessionId: string } {
  const studioId = studioSessionId(c);
  const browserId = browserSessionId(dependencies, c);
  if (!dependencies.history.isAttached(browserId, studioId, projectId)) {
    fail(ErrorCode.SchemaInvalid, "studio session is not attached to this project", STUDIO_SESSION_HEADER);
  }
  return { browserSessionId: browserId, studioSessionId: studioId };
}

/** Server-owned UI invocation; transport input can never choose history semantics or labels. */
export function studioWriteInvocation(
  dependencies: StudioRouteDependencies | undefined,
  c: Context,
  projectId: ProjectId,
  label: string,
): WriteInvocation {
  if (!dependencies) {
    return { origin: ignoredMutationOriginForActor("user"), toolAudit: null };
  }
  const attached = requireAttachedStudio(dependencies, c, projectId);
  return {
    origin: {
      kind: "ui",
      sessionId: attached.studioSessionId,
      label,
      historyAction: "record",
      historyOperation: null,
    },
    toolAudit: null,
  };
}
