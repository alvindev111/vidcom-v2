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
  /** The operating system refused to read a path. An answer, not a fault. */
  PathPermissionDenied = "path_permission_denied",
  ProjectNotFound = "project_not_found",
  ProjectInvalid = "project_invalid",
  IdentityParseError = "identity_parse_error",
  CompositionParseError = "composition_parse_error",
  DependencyGraphUnavailable = "dependency_graph_unavailable",
  ThumbnailCapacity = "thumbnail_capacity",
  SourceChanging = "source_changing",
  NoComposition = "no_composition",
  NoScenes = "no_scenes",
  NotFound = "not_found",
  WriteConflict = "write_conflict",
  IdempotencyKeyReused = "idempotency_key_reused",
  WorkspaceLeaseLost = "workspace_lease_lost",
  TimingInvalid = "timing_invalid",
  DurationOverflow = "duration_overflow",
  InvariantViolated = "invariant_violated",
  SceneNotFound = "scene_not_found",
  SdkRejected = "sdk_rejected",
  NoFile = "no_file",
  TooLarge = "too_large",
  UnsupportedMedia = "unsupported_media",
  IntegrityMismatch = "integrity_mismatch",
  Internal = "internal",
  StorageUnavailable = "storage_unavailable",
  WorkspaceLeaseDenied = "workspace_lease_denied",
  /** A switch was refused because work is still running in the current workspace. */
  WorkspaceBusy = "workspace_busy",
  /** A mutation arrived while a switch was mid-flight; the caller should retry. */
  WorkspaceSwitching = "workspace_switching",
  /** The requested workspace could not be brought up at all. */
  WorkspaceUnavailable = "workspace_unavailable",
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
  BridgeCredentialUnavailable = "bridge_credential_unavailable",
  /** The system bridge bearer is invalid; user MCP credentials use `credential_invalid`. */
  BridgeCredentialInvalid = "bridge_credential_invalid",
  BridgeRotationInProgress = "bridge_rotation_in_progress",
  DownloadTlsUntrusted = "download_tls_untrusted",
  /**
   * A runtime download could not complete: unreachable, timed out, or left
   * partial. Distinct from `download_tls_untrusted`, which names a trust
   * failure the user can fix by supplying a bundle.
   */
  DownloadUnavailable = "download_unavailable",
  /** An HTTP body crossed its route limit; project asset quotas use `too_large`. */
  PayloadTooLarge = "payload_too_large",
  DaemonIdentityMismatch = "daemon_identity_mismatch",
  DaemonUnavailable = "daemon_unavailable",
  CompilerUnavailable = "compiler_unavailable",
  RuntimeManifestInvalid = "runtime_manifest_invalid",
  RuntimeExtractionIncomplete = "runtime_extraction_incomplete",
  BootstrapLockTimeout = "bootstrap_lock_timeout",
  PathTimeout = "path_timeout",
  BrowseTokenInvalid = "browse_token_invalid",
  ProjectImportConflict = "project_import_conflict",
  /** The agent CLI is not installed, or the PTY layer refused to start it. */
  AgentUnavailable = "agent_unavailable",
  /** Opening another agent terminal would cross the concurrent-process ceiling. */
  AgentSessionLimit = "agent_session_limit",
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
