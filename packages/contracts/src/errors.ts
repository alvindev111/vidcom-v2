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
  ProjectInvalid = "project_invalid",
  IdentityParseError = "identity_parse_error",
  CompositionParseError = "composition_parse_error",
  NoComposition = "no_composition",
  NoScenes = "no_scenes",
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
  RemoteAssetNotLocal = "remote_asset_not_local",
  RenderBinaryMissing = "render_binary_missing",
  SubTimelineReadinessTimeout = "sub_timeline_readiness_timeout",
  ProcessTerminationUnverified = "process_termination_unverified",
  ConfirmationRequired = "confirmation_required",
  RollbackPayloadPruned = "rollback_payload_pruned",
  CommittedResponseError = "committed_response_error",
  TtsProviderUnavailable = "tts_provider_unavailable",
  TtsCredentialMissing = "tts_credential_missing",
  TtsVoiceNotSupported = "tts_voice_not_supported",
  TtsQuotaExceeded = "tts_quota_exceeded",
  TtsSynthesisFailed = "tts_synthesis_failed",
}

/** Stable machine-readable warning codes exposed with job results. */
export enum WarningCode {
  ExternalDependencyUnpinned = "external_dependency_unpinned",
  SubTimelineReadinessTimeout = "sub_timeline_readiness_timeout",
  TerminationProofNotExhaustive = "termination_proof_not_exhaustive",
  EngineVersionDrift = "engine_version_drift",
}

/** Structured error payload returned by HTTP and MCP adapters. */
export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}
