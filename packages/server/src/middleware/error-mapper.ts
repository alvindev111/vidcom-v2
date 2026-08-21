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
  [ErrorCode.ProjectInvalid]: 409,
  [ErrorCode.IdentityParseError]: 422,
  [ErrorCode.CompositionParseError]: 422,
  [ErrorCode.DependencyGraphUnavailable]: 422,
  [ErrorCode.ThumbnailCapacity]: 429,
  [ErrorCode.SourceChanging]: 409,
  [ErrorCode.NoComposition]: 422,
  [ErrorCode.NoScenes]: 422,
  [ErrorCode.SubTimelineReadinessTimeout]: 422,
  [ErrorCode.NotFound]: 404,
  [ErrorCode.WriteConflict]: 409,
  [ErrorCode.IdempotencyKeyReused]: 409,
  [ErrorCode.WorkspaceLeaseLost]: 409,
  [ErrorCode.TimingInvalid]: 422,
  [ErrorCode.TimingNotFrameAligned]: 422,
  [ErrorCode.DurationOverflow]: 422,
  [ErrorCode.InvariantViolated]: 422,
  [ErrorCode.SceneNotFound]: 422,
  [ErrorCode.SdkRejected]: 422,
  [ErrorCode.NoFile]: 404,
  [ErrorCode.TooLarge]: 413,
  [ErrorCode.ResourceLimitExceeded]: 413,
  [ErrorCode.UnsupportedMedia]: 415,
  [ErrorCode.IntegrityMismatch]: 422,
  [ErrorCode.Internal]: 500,
  [ErrorCode.StorageUnavailable]: 500,
  [ErrorCode.WorkspaceLeaseDenied]: 503,
  [ErrorCode.ApprovalRequired]: 403,
  [ErrorCode.ApprovalExpired]: 403,
  [ErrorCode.ApprovalInvalid]: 403,
  [ErrorCode.CredentialInvalid]: 401,
  [ErrorCode.ToolNotAvailableInEra]: 422,
  [ErrorCode.ReferencedByComposition]: 422,
  [ErrorCode.BackupFailed]: 503,
  [ErrorCode.BackupExpired]: 410,
  [ErrorCode.DuplicateMutationTarget]: 422,
  [ErrorCode.RecoveryRequired]: 503,
  [ErrorCode.RemoteAssetNotLocal]: 422,
  [ErrorCode.RenderBinaryMissing]: 503,
  [ErrorCode.ProcessTerminationUnverified]: 500,
  [ErrorCode.ConfirmationRequired]: 403,
  [ErrorCode.RollbackPayloadPruned]: 410,
  [ErrorCode.CommittedResponseError]: 500,
  [ErrorCode.TtsProviderUnavailable]: 503,
  [ErrorCode.TtsCredentialMissing]: 422,
  [ErrorCode.TtsVoiceNotSupported]: 422,
  [ErrorCode.TtsQuotaExceeded]: 429,
  [ErrorCode.TtsSynthesisFailed]: 502,
  [ErrorCode.BridgeCredentialUnavailable]: 503,
  [ErrorCode.BridgeCredentialInvalid]: 401,
  [ErrorCode.BridgeRotationInProgress]: 409,
  // 409: the workspace is doing something else, and retrying later can succeed.
  // 403: the user's own operating system said no; the request was well formed.
  [ErrorCode.PathPermissionDenied]: 403,
  [ErrorCode.WorkspaceBusy]: 409,
  // 503: mid-switch is explicitly temporary, so it advertises a retry.
  [ErrorCode.WorkspaceSwitching]: 503,
  [ErrorCode.WorkspaceUnavailable]: 503,
  [ErrorCode.DownloadTlsUntrusted]: 502,
  // A dependency the daemon could not fetch, not a fault in the request.
  [ErrorCode.DownloadUnavailable]: 502,
  [ErrorCode.PayloadTooLarge]: 413,
  [ErrorCode.DaemonIdentityMismatch]: 409,
  [ErrorCode.DaemonUnavailable]: 503,
  [ErrorCode.CompilerUnavailable]: 503,
  [ErrorCode.RuntimeManifestInvalid]: 500,
  [ErrorCode.RuntimeExtractionIncomplete]: 503,
  [ErrorCode.BootstrapLockTimeout]: 503,
  [ErrorCode.PathTimeout]: 504,
  [ErrorCode.BrowseTokenInvalid]: 400,
  [ErrorCode.ProjectImportConflict]: 409,
  // 503: the agent CLI is missing from the machine, not from the request.
  [ErrorCode.AgentUnavailable]: 503,
  // 409: another terminal has to be closed first, and then this same call works.
  [ErrorCode.AgentSessionLimit]: 409,
} as const satisfies Record<ErrorCode, number>;

export class HttpBoundaryError extends Error {
  constructor(readonly detail: ErrorDetail, readonly status?: number) {
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
  const status = error instanceof HttpBoundaryError && error.status !== undefined
    ? error.status
    : errorStatus(detail.code);
  return c.json(current === undefined ? { error: detail } : { error: detail, current }, status as 400);
}
