import { ErrorCode, type DomainError, type Era } from "@vidcom/contracts";

export const MCP_INVALID_PARAMS = -32602;
export const MCP_INTERNAL_ERROR = -32603;
export const MCP_LEGACY_RESOURCE_NOT_FOUND = -32002;
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export interface MappedMcpError {
  code: number;
  message: string;
  data: {
    error: DomainError;
    retryable: false;
    guidance?: string;
  };
}

function protocolCode(error: DomainError, era: Era): number {
  switch (error.code) {
    case ErrorCode.ProjectNotFound:
    case ErrorCode.NotFound:
    case ErrorCode.NoFile:
      return era === "legacy" ? MCP_LEGACY_RESOURCE_NOT_FOUND : MCP_INVALID_PARAMS;
    case ErrorCode.Internal:
    case ErrorCode.StorageUnavailable:
    case ErrorCode.WorkspaceLeaseDenied:
    case ErrorCode.WorkspaceLeaseLost:
    case ErrorCode.BackupFailed:
    case ErrorCode.BackupExpired:
    case ErrorCode.RecoveryRequired:
    case ErrorCode.RenderBinaryMissing:
    case ErrorCode.ProcessTerminationUnverified:
    case ErrorCode.CommittedResponseError:
    // Machine state, not a bad call: the engine is missing, out of credit or
    // simply failed. Retrying with different arguments will not help.
    case ErrorCode.TtsProviderUnavailable:
    case ErrorCode.TtsQuotaExceeded:
    case ErrorCode.TtsSynthesisFailed:
      return MCP_INTERNAL_ERROR;
    case ErrorCode.SchemaInvalid:
    case ErrorCode.PathRequired:
    case ErrorCode.PathInvalid:
    case ErrorCode.VersionFormatLegacy:
    case ErrorCode.PreconditionRequired:
    case ErrorCode.AuthRequired:
    case ErrorCode.AuthNonceInvalid:
    case ErrorCode.HostNotAllowed:
    case ErrorCode.OriginNotAllowed:
    case ErrorCode.AssetNotAllowed:
    case ErrorCode.PathOutsideProject:
    case ErrorCode.ProjectInvalid:
    case ErrorCode.IdentityParseError:
    case ErrorCode.CompositionParseError:
    case ErrorCode.NoComposition:
    case ErrorCode.NoScenes:
    case ErrorCode.SubTimelineReadinessTimeout:
    case ErrorCode.WriteConflict:
    case ErrorCode.IdempotencyKeyReused:
    case ErrorCode.TimingInvalid:
    case ErrorCode.DurationOverflow:
    case ErrorCode.SceneNotFound:
    case ErrorCode.SdkRejected:
    case ErrorCode.TooLarge:
    case ErrorCode.UnsupportedMedia:
    case ErrorCode.ApprovalRequired:
    case ErrorCode.ApprovalExpired:
    case ErrorCode.ApprovalInvalid:
    case ErrorCode.CredentialInvalid:
    case ErrorCode.ToolNotAvailableInEra:
    case ErrorCode.ReferencedByComposition:
    case ErrorCode.DuplicateMutationTarget:
    case ErrorCode.RemoteAssetNotLocal:
    case ErrorCode.ConfirmationRequired:
    case ErrorCode.RollbackPayloadPruned:
    case ErrorCode.TtsCredentialMissing:
    case ErrorCode.TtsVoiceNotSupported:
      return MCP_INVALID_PARAMS;
  }
}

/** Sole era-aware DomainError mapping used by every MCP transport. */
export function mapMcpError(error: DomainError, era: Era): MappedMcpError {
  return {
    code: protocolCode(error, era),
    message: error.message,
    data: {
      error,
      retryable: false,
      ...(error.code === ErrorCode.RecoveryRequired
        ? { guidance: "Inspect and resolve the reported journal before retrying this write." }
        : error.code === ErrorCode.CommittedResponseError
          ? { guidance: "The mutation is already committed. Do not retry; inspect the reported revision identity." }
          : {}),
    },
  };
}

/** Canonical tool-error result; numeric protocol category remains machine-readable in metadata and text. */
export function mcpToolError(error: DomainError, era: Era) {
  const mapped = mapMcpError(error, era);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(mapped) }],
    _meta: { "io.vidcom/error": mapped },
  };
}
