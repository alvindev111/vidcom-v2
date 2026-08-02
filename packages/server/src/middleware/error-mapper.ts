import { ErrorCode, type ErrorDetail } from "@vidcom/contracts";
import type { Context } from "hono";

const ERROR_STATUS = {
  [ErrorCode.SchemaInvalid]: 400,
  [ErrorCode.PathRequired]: 400,
  [ErrorCode.PathInvalid]: 400,
  [ErrorCode.VersionFormatLegacy]: 400,
  [ErrorCode.PreconditionRequired]: 400,
  [ErrorCode.AuthRequired]: 401,
  [ErrorCode.AuthNonceInvalid]: 401,
  [ErrorCode.HostNotAllowed]: 403,
  [ErrorCode.OriginNotAllowed]: 403,
  [ErrorCode.AssetNotAllowed]: 403,
  [ErrorCode.PathOutsideProject]: 403,
  [ErrorCode.ProjectNotFound]: 404,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.WriteConflict]: 409,
  [ErrorCode.IdempotencyKeyReused]: 409,
  [ErrorCode.WorkspaceLeaseLost]: 409,
  [ErrorCode.TimingInvalid]: 422,
  [ErrorCode.DurationOverflow]: 422,
  [ErrorCode.SceneNotFound]: 422,
  [ErrorCode.SdkRejected]: 422,
  [ErrorCode.NoFile]: 404,
  [ErrorCode.TooLarge]: 413,
  [ErrorCode.UnsupportedMedia]: 415,
  [ErrorCode.Internal]: 500,
  [ErrorCode.StorageUnavailable]: 503,
  [ErrorCode.WorkspaceLeaseDenied]: 503,
  [ErrorCode.ApprovalRequired]: 422,
  [ErrorCode.ApprovalExpired]: 422,
  [ErrorCode.ApprovalInvalid]: 422,
  [ErrorCode.CredentialInvalid]: 401,
  [ErrorCode.ToolNotAvailableInEra]: 422,
  [ErrorCode.ReferencedByComposition]: 422,
  [ErrorCode.BackupFailed]: 503,
  [ErrorCode.BackupExpired]: 410,
  [ErrorCode.DuplicateMutationTarget]: 422,
  [ErrorCode.RecoveryRequired]: 503,
} as const satisfies Record<ErrorCode, number>;

export class HttpBoundaryError extends Error {
  constructor(readonly detail: ErrorDetail) {
    super(detail.message);
    this.name = "HttpBoundaryError";
  }
}

export function errorStatus(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

/** Sole ErrorCode-to-status boundary for the HTTP adapter. */
export function mapHttpError(error: unknown, c: Context): Response {
  const detail = error instanceof HttpBoundaryError
    ? error.detail
    : { code: ErrorCode.Internal, message: "internal server error" };
  const current = detail.code === ErrorCode.WriteConflict ? detail.details?.current : undefined;
  return c.json(current === undefined ? { error: detail } : { error: detail, current }, errorStatus(detail.code) as 400);
}
