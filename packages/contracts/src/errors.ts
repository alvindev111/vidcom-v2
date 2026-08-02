/** Stable machine-readable error codes shared by every VidCom boundary. */
export enum ErrorCode {
  SchemaInvalid = "schema_invalid",
  PathRequired = "path_required",
  PathInvalid = "path_invalid",
  VersionFormatLegacy = "version_format_legacy",
  PreconditionRequired = "precondition_required",
  AuthRequired = "auth_required",
  AuthNonceInvalid = "auth_nonce_invalid",
  HostNotAllowed = "host_not_allowed",
  OriginNotAllowed = "origin_not_allowed",
  AssetNotAllowed = "asset_not_allowed",
  PathOutsideProject = "path_outside_project",
  ProjectNotFound = "project_not_found",
  NotFound = "not_found",
  WriteConflict = "write_conflict",
  IdempotencyKeyReused = "idempotency_key_reused",
  WorkspaceLeaseLost = "workspace_lease_lost",
  TimingInvalid = "timing_invalid",
  DurationOverflow = "duration_overflow",
  SceneNotFound = "scene_not_found",
  SdkRejected = "sdk_rejected",
  NoFile = "no_file",
  TooLarge = "too_large",
  UnsupportedMedia = "unsupported_media",
  Internal = "internal",
  StorageUnavailable = "storage_unavailable",
  WorkspaceLeaseDenied = "workspace_lease_denied",
  ApprovalRequired = "approval_required",
  ApprovalExpired = "approval_expired",
  ApprovalInvalid = "approval_invalid",
  CredentialInvalid = "credential_invalid",
  ToolNotAvailableInEra = "tool_not_available_in_era",
  ReferencedByComposition = "referenced_by_composition",
  BackupFailed = "backup_failed",
  BackupExpired = "backup_expired",
  DuplicateMutationTarget = "duplicate_mutation_target",
  RecoveryRequired = "recovery_required",
  CommittedResponseError = "committed_response_error",
}

/** Structured error payload returned by HTTP and MCP adapters. */
export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}
