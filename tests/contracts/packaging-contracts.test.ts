import { describe, expect, it } from "vitest";

import {
  BridgeAttachmentCreateRequestSchema,
  BridgeAttachmentCreateResponseSchema,
  BridgeAttachmentParamsSchema,
  BridgeAttachmentRenewRequestSchema,
  BridgeAttachmentRenewResponseSchema,
  BridgeClientKindSchema,
  BridgeHandshakeRequestSchema,
  BridgeHandshakeResponseSchema,
  BridgeToolInvokeRequestSchema,
  BridgeToolInvokeResponseSchema,
  BrowseEntrySchema,
  BrowsePageSchema,
  BrowseRootSchema,
  CreateSystemDirectoryRequestSchema,
  CreateSystemDirectoryResponseSchema,
  DomainEventSchema,
  ErrorDetailSchema,
  ErrorCode,
  FilesystemEntriesRequestSchema,
  FilesystemEntriesResponseSchema,
  FilesystemRootsResponseSchema,
  GetJobStatusOutputSchema,
  MCP_PUBLIC_ERROR_CODES,
  resolveVidcomSettings,
  RuntimeSettingsSchema,
  SystemRuntimeArchiveSchema,
  SystemRuntimeSchema,
  SystemWorkspaceInfoSchema,
  SystemWorkspaceSchema,
  SystemWorkspaceStateSchema,
} from "@vidcom/contracts";

const PACKAGING_ERROR_CODES = [
  ErrorCode.BridgeCredentialUnavailable,
  ErrorCode.BridgeCredentialInvalid,
  ErrorCode.BridgeRotationInProgress,
  ErrorCode.DownloadTlsUntrusted,
  ErrorCode.PayloadTooLarge,
  ErrorCode.DaemonIdentityMismatch,
  ErrorCode.DaemonUnavailable,
  ErrorCode.CompilerUnavailable,
  ErrorCode.RuntimeManifestInvalid,
  ErrorCode.RuntimeExtractionIncomplete,
  ErrorCode.BootstrapLockTimeout,
  ErrorCode.PathTimeout,
  ErrorCode.BrowseTokenInvalid,
  ErrorCode.ProjectImportConflict,
] as const;

describe("packaging and distribution contracts", () => {
  it("publishes the fourteen packaging error codes without duplicating lease loss", () => {
    expect(PACKAGING_ERROR_CODES).toEqual([
      "bridge_credential_unavailable",
      "bridge_credential_invalid",
      "bridge_rotation_in_progress",
      "download_tls_untrusted",
      "payload_too_large",
      "daemon_identity_mismatch",
      "daemon_unavailable",
      "compiler_unavailable",
      "runtime_manifest_invalid",
      "runtime_extraction_incomplete",
      "bootstrap_lock_timeout",
      "path_timeout",
      "browse_token_invalid",
      "project_import_conflict",
    ]);
    expect(ErrorCode.WorkspaceLeaseLost).toBe("workspace_lease_lost");
    expect(new Set(Object.values(ErrorCode)).size).toBe(Object.values(ErrorCode).length);
  });

  it("publishes strict filesystem, workspace, and runtime DTOs", () => {
    const root = { name: "Home", displayPath: "/Users/me", token: "root-token", canWrite: true };
    const entry = {
      name: "Videos",
      displayPath: "/Users/me/Videos",
      token: "entry-token",
      isDir: true,
      canWrite: true,
    };
    const page = {
      directory: root,
      parentToken: null,
      entries: [entry],
      nextCursor: null,
      truncated: false,
    };
    const runtimeArchive = { key: "media-darwin-arm64", status: "ready", version: "1.0.0" };
    const cases = [
      [BrowseRootSchema, root],
      [BrowseEntrySchema, entry],
      [BrowsePageSchema, page],
      [FilesystemRootsResponseSchema, { roots: [root] }],
      [FilesystemEntriesRequestSchema, { token: "root-token", cursor: "next" }],
      [FilesystemEntriesResponseSchema, page],
      [CreateSystemDirectoryRequestSchema, { parentToken: "root-token", name: "Exports" }],
      [CreateSystemDirectoryResponseSchema, { entry }],
      [SystemWorkspaceInfoSchema, { root: "/Users/me", name: "me" }],
      [SystemWorkspaceSchema, { state: "active", workspace: { root: "/Users/me", name: "me" } }],
      [SystemRuntimeArchiveSchema, runtimeArchive],
      [SystemRuntimeSchema, { state: "ready", archives: [runtimeArchive] }],
      [RuntimeSettingsSchema, { caBundlePath: "/company/ca.pem" }],
    ] as const;

    for (const [schema, valid] of cases) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    }
    expect(CreateSystemDirectoryRequestSchema.safeParse({ parentToken: "token", name: ".." }).success).toBe(false);
    expect(CreateSystemDirectoryRequestSchema.safeParse({ parentToken: "token", name: "a/b" }).success).toBe(false);
    expect(SystemWorkspaceStateSchema.options).toEqual([
      "none",
      "starting",
      "active",
      "switching",
      "reacquiring",
      "failed",
    ]);
    for (const state of SystemWorkspaceStateSchema.options) {
      expect(SystemWorkspaceSchema.safeParse({ state }).success).toBe(true);
    }
  });

  it("caps filesystem entry pages at five hundred entries", () => {
    const root = { name: "Home", displayPath: "/Users/me", token: "root-token", canWrite: true };
    const entry = {
      name: "Videos",
      displayPath: "/Users/me/Videos",
      token: "entry-token",
      isDir: true,
      canWrite: true,
    };
    const page = {
      directory: root,
      parentToken: null,
      nextCursor: null,
      truncated: false,
    };

    expect(FilesystemEntriesResponseSchema.safeParse({ ...page, entries: Array(500).fill(entry) }).success).toBe(true);
    expect(FilesystemEntriesResponseSchema.safeParse({ ...page, entries: Array(501).fill(entry) }).success).toBe(false);
  });

  it("resolves runtime.caBundlePath from the settings document without an environment override", () => {
    expect(resolveVidcomSettings({
      runtime: { caBundlePath: "/file/company-ca.pem" },
    }).runtime.caBundlePath).toBe("/file/company-ca.pem");
  });

  it("trims the environment CA bundle override and gives it precedence over the file", () => {
    expect(resolveVidcomSettings(
      { runtime: { caBundlePath: "/file/company-ca.pem" } },
      { caBundlePath: "  /env/company-ca.pem\t" },
    ).runtime.caBundlePath).toBe("/env/company-ca.pem");
  });

  it("treats blank and null CA bundle overrides as absent", () => {
    const document = { runtime: { caBundlePath: "/file/company-ca.pem" } };

    expect(resolveVidcomSettings(document, { caBundlePath: "  \t" }).runtime.caBundlePath)
      .toBe("/file/company-ca.pem");
    expect(resolveVidcomSettings(document, { caBundlePath: null }).runtime.caBundlePath)
      .toBe("/file/company-ca.pem");
    expect(resolveVidcomSettings({ runtime: { caBundlePath: null } }).runtime.caBundlePath)
      .toBeNull();
  });

  it("publishes strict bridge handshake, attachment, and invocation envelopes", () => {
    const attachmentId = "a".repeat(64);
    const timestamp = "2026-08-07T12:00:00.000Z";
    const error = { code: ErrorCode.DaemonUnavailable, message: "daemon stopped" };
    const cases = [
      [BridgeHandshakeRequestSchema, {
        workspaceRoot: "/workspace",
        expectedInstanceId: "daemon-1",
        clientKind: "bridge",
        clientVersion: "1.0.0",
      }],
      [BridgeHandshakeResponseSchema, {
        workspaceRoot: "/workspace",
        instanceId: "daemon-1",
        protocolVersions: ["2025-11-25"],
        daemonVersion: "1.0.0",
      }],
      [BridgeAttachmentCreateRequestSchema, { kind: "bridge" }],
      [BridgeAttachmentCreateResponseSchema, { attachmentId, heartbeatEveryMs: 5_000, expiresAt: timestamp }],
      [BridgeAttachmentParamsSchema, { id: attachmentId }],
      [BridgeAttachmentRenewRequestSchema, {}],
      [BridgeAttachmentRenewResponseSchema, { expiresAt: timestamp }],
      [BridgeToolInvokeRequestSchema, {
        input: { projectId: "project-1" },
        protocolVersion: "2025-11-25",
        requestState: "approval-1",
      }],
      [BridgeToolInvokeResponseSchema, { ok: true, value: { projectRevision: 2 } }],
      [BridgeToolInvokeResponseSchema, { ok: false, error }],
    ] as const;

    for (const [schema, valid] of cases) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    }
    expect(BridgeClientKindSchema.options).toEqual(["bridge", "ui", "render"]);
  });

  it("round-trips every packaging error through the shared strict error DTO", () => {
    for (const code of PACKAGING_ERROR_CODES) {
      const value = { code, message: `failure: ${code}`, details: { limit: 1 } };
      expect(ErrorDetailSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
      expect(ErrorDetailSchema.safeParse({ ...value, unexpected: true }).success).toBe(false);
    }
  });

  it("keeps packaging-only codes out of the published MCP job output", () => {
    const failedJob = {
      id: "job-1",
      type: "render",
      status: "failed",
      progress: 1,
      stage: null,
      result: null,
      error: { code: ErrorCode.Internal, message: "render failed" },
      warnings: null,
      cleanupPending: false,
      attempt: 1,
      createdAt: "2026-08-07T12:00:00.000Z",
      startedAt: "2026-08-07T12:00:01.000Z",
      finishedAt: "2026-08-07T12:00:02.000Z",
      outcome: "failed",
      pollAfterMs: null,
    };
    const publicCodes = new Set<ErrorCode>(MCP_PUBLIC_ERROR_CODES);

    expect(GetJobStatusOutputSchema.safeParse(failedJob).success).toBe(true);
    for (const code of PACKAGING_ERROR_CODES) {
      expect(publicCodes.has(code)).toBe(false);
      expect(GetJobStatusOutputSchema.safeParse({
        ...failedJob,
        error: { code, message: "private packaging failure" },
      }).success).toBe(false);
    }
  });

  it("publishes the four new host lifecycle events through the strict SSE contract", () => {
    for (const type of [
      "workspace.lease_lost",
      "workspace.reattached",
      "runtime.preparing",
      "runtime.ready",
    ] as const) {
      const event = { id: 1, type, projectId: null, payload: {} };
      expect(DomainEventSchema.safeParse(event).success).toBe(true);
      expect(DomainEventSchema.safeParse({ ...event, unexpected: true }).success).toBe(false);
    }
  });
});
