# Raw review — security, approval, backup, credentials

Scope read: checklist H/I/N; steering `07-data-and-storage.md`, `09-security.md` (plus path rules in `06-validation.md`); current production code and relevant tests. Review was read-only except this requested raw-findings artifact.

## Findings by severity

### HIGH — Pinned/latest HTTP handlers drop the authenticated credential context

Evidence:

- `packages/mcp/src/http.ts:44-69`: `pinnedHandler()` receives `options`, but on the accepted branch calls `inner(request)` at line 68 instead of `inner(request, options)`.
- `packages/server/src/routes/mcp.ts:25-30`: the Hono perimeter correctly passes only the verified `credentialId` as `authInfo.clientId` to the MCP handler.
- `packages/mcp/src/server.ts:44-46,69-74`: Registry attribution derives `credentialId` from SDK/factory auth context. Once `options` is dropped it becomes `null`.
- This conflicts with checklist N.8 and Detailed Goals R6d.6: HTTP credential use must be auditable by credential ID.

Observed repro (no source edits):

```text
entry credential-proof
2025-06-18 null
```

The direct entry handler preserved `authInfo.clientId`; the exact pinned handler returned 200 for the same tool call but recorded `credentialId: null`. `latest` aliases the pinned modern wrapper (`packages/mcp/src/http.ts:108`) and has the same code path.

Impact/edge scenario: a valid bearer calls a write/destructive tool through `/api/mcp/<revision>` or `/api/mcp/latest`. Authorization still succeeds, but the durable tool audit loses which credential performed the action. Revocation incident response and per-host attribution become unreliable precisely on the documented revision endpoints.

Fix: change the accepted branch to `inner(request, options)`. Add Hono-to-real-SDK integration cases for entry, every exact revision, and latest that assert persisted/read audit `credentialId` equals the verified ID and bearer plaintext is absent.

### HIGH — Destructive grant and backup are vulnerable to an external-edit TOCTOU window

Evidence:

- `packages/core/src/service/write-authority.ts:236-345`: current hashes and grant `targetHashes` are validated before T1.
- `packages/core/src/service/write-authority.ts:369-383`: T1 reserves the grant and persists the journal.
- `packages/core/src/service/write-authority.ts:395-411`: backup re-reads source paths, but neither `BackupPort.create()` nor the caller compares the copied hashes with the already validated `StepIntent.fromHash`.
- `packages/core/src/service/write-authority.ts:422-426`: filesystem write/delete then executes without re-resolving targets or rechecking live hashes.
- `packages/adapter/src/fs/backup-store.ts:127-135`: backup hashes whatever bytes happen to be on disk during the copy; there is no expected-hash input.
- `packages/adapter/src/fs/workspace-fs.ts:144-162`: `writeAtomic`/`deleteAtomic` deliberately do not enforce a precondition themselves.
- Steering 07 §5 explicitly permits external editors and says those changes must be detected; approval binding is intended to cover target hashes.

Exploit/edge scenario: grant is approved for hash A. After validation/T1, an editor changes the target (or a composition file used for reference safety) to B. Backup can capture A or B depending on timing, then the mutation overwrites/deletes B. The approved binding never authorized B; if the backup captured A, B is unrecoverable. For `delete_file`, an external edit can also add a new composition reference after re-planning, so an actively referenced file may be deleted.

Fix: make backup creation accept expected `{path, fromHash}` values and fail if copied bytes differ; after backup publish+verify, re-resolve every target and recheck all `fromHash` values immediately before the first mutation, aborting T1/releasing the grant with `write_conflict` on mismatch. Include every file whose contents establish destructive safety (for example reference-scan sources) in the binding. Add deterministic hooks/tests for edits (a) after validation, (b) during backup copy, and (c) after backup verify/before first write.

### MEDIUM — Request logging leaks arbitrary query secrets and absolute user paths

Evidence:

- `packages/server/src/middleware/perimeter.ts:33-42`: `redactRequestUrl()` deletes only the query key `t`, then logs the entire URL.
- `packages/server/src/app.ts:57-60`: logging runs before Host, CORS, auth, schema, and path rejection.
- Steering 09 §10 forbids logging token/credential and absolute paths containing user names at info level.
- `tests/server/security.test.ts:200-206` covers only `?t=top-secret`, leaving `token`, `access_token`, `credential`, `authorization`, `path`, and arbitrary secret-bearing keys untested.

Exploit/edge scenario: even an unauthenticated or hostile-Host request such as `GET /api/v1/projects/x/files?path=/Users/alice/private.txt&access_token=vcmcp_...` is logged before perimeter rejection. The Authorization header is not logged, but credentials or local paths accidentally placed in any other query key persist in logs.

Fix: safest is to log method plus pathname only. If query diagnostics are required, use an allowlist of known non-sensitive keys and redact by normalized key patterns (`token`, `secret`, `credential`, `authorization`, `key`, `path`) before serialization. Add tests for hostile Host and unauthenticated requests containing query secrets/absolute paths.

### MEDIUM — Expired requested/issued approval rows are never reclaimed unless someone touches them first

Evidence:

- `packages/adapter/src/db/approval-grants.ts:119-129`: startup cleanup deletes only rows whose stored status is already `consumed`, `expired`, `revoked`, or `invalidated`.
- `packages/adapter/src/db/approval-grants.ts:83-97`: a requested row is marked `expired` only when that exact request is later passed to `issue()`.
- `packages/adapter/src/db/journal.ts:160-168`: an issued row is marked `expired` only when a reserve is attempted.
- `packages/cli/src/startup.ts:131-133`: startup calls only `cleanupTerminal`; it does not first materialize time-expired requested/issued states.
- Every no-grant destructive invocation creates a new request at `packages/mcp/src/registry/destructive-tools.ts:29-38`.

Exploit/edge scenario: a valid but buggy/compromised AI host repeatedly calls `delete_file`/`delete_scene` without a grant. Each call creates a 10-minute request. If the user never issues those exact IDs, their status remains `requested` forever and the 7-day cleanup never sees them. Unused issued grants leak similarly. This gives an authenticated client an unbounded SQLite growth vector.

Fix: in cleanup, atomically transition all `requested`/`issued` rows with `expires_at <= now` to `expired`, then prune terminal rows older than retention while preserving unresolved journal links. Alternatively delete logically expired unlinked requested/issued rows directly. Add startup tests with untouched requested and issued rows older than TTL+retention.

### MEDIUM — Backup failure can leave a pending journal/grant while returning ordinary `backup_failed`

Evidence:

- `packages/core/src/service/write-authority.ts:385-393` and `412-418`: after T1, missing backup storage or backup create/verify/attach failure calls `abortComposite(...).catch(() => {})`, discards any abort failure, and always returns `BackupFailed`.
- The later filesystem-step failure path correctly treats an abort failure differently: `packages/core/src/service/write-authority.ts:427-445` retries reconciliation and returns `RecoveryRequired` if the journal remains pending.

Edge scenario: SQLite becomes unavailable after the verified backup fails. T1 remains `pending`, the grant remains `reserved`, and the project is write-gated, but the caller receives a normal `backup_failed` with no `journalId`/recovery instruction. The next write unexpectedly fails with `recovery_required`; modern audit ownership also remains journal-owned without the caller knowing outcome is unresolved.

Fix: apply the same abort/reconcile handling used by the filesystem-step failure branch. Only return `backup_failed` after abort/release is confirmed terminal; otherwise return `recovery_required` with journal ID and phase.

### MEDIUM — Backup payload pruning is not crash-consistent with `payload_pruned_at`

Evidence:

- `packages/adapter/src/fs/backup-store.ts:277-299`: each payload directory is recursively removed first (lines 288-292), then SQLite metadata is updated (lines 293-296).
- `packages/core/src/usecase/restore-backup.ts:46-53`: restore returns `backup_expired` only when metadata is marked pruned; otherwise missing payload is reported as `backup_failed` integrity corruption.

Edge scenario: process crash or SQLite failure after `rm` but before the update leaves durable metadata claiming the backup is restorable while bytes are gone. Startup retries `rm`, but until the DB update succeeds `read()` still reports `payloadPrunedAt: null`; restore/verify misclassify normal retention as corruption.

Fix: use a crash-recoverable tombstone sequence (atomic rename payload directory to a prune staging name, durable DB mark, then remove staging) and reconcile tombstones on startup, or at minimum update state through an explicit `pruning` marker before deletion. Add crash injection between filesystem removal and DB update.

### LOW — Allowed CORS origins are dynamically reflected despite the steering prohibition

Evidence:

- `packages/server/src/middleware/perimeter.ts:56-67`: after allowlist membership, response header is set from the request value: `Access-Control-Allow-Origin: origin`.
- Steering 09 §4 says not to reflect request `Origin`; current hostile-origin tests only prove unlisted origins are not reflected (`tests/server/security.test.ts:99-107`).

Impact: current Set membership prevents arbitrary-origin reflection, so this is not an immediate origin bypass. It is nevertheless a direct policy mismatch and makes future origin-normalization mistakes more dangerous. The middleware also does not implement a complete credentialed preflight response, so an actually cross-origin UI origin may not work reliably.

Fix: resolve to a canonical configured origin value and emit that constant; add allowed-origin/preflight tests (methods, allowed headers, credentials policy) rather than only hostile-origin tests.

### LOW — Credential DB file is restricted only after SQLite opens/creates it

Evidence:

- `packages/adapter/src/db/client.ts:16-24`: `new DatabaseSync(filename)` runs before `secureCredentialFileSync(filename)`.
- `packages/adapter/src/db/client.ts:35-37`: app-data directory is created with default mode and no explicit owner-only mode.
- Detailed Design §5.14 requires the SQLite file holding credential hashes/audit state to be locked to 0600/Windows equivalent.

Edge scenario: on a permissive umask/app-data parent, a newly created DB can briefly exist with group/other permissions before chmod/ACL repair. The same post-create window exists on Windows before `icacls` completes. A local observer can race file creation. Stored MCP data is hashed rather than plaintext, so impact is limited, but audit/journal data is also sensitive.

Fix: precreate the DB file with exclusive owner-only permissions (and app-data directory 0700) before opening SQLite; on Windows establish the restricted directory/file ACL before any sensitive write. Verify main DB plus WAL/SHM/journal artifacts retain owner-only permissions.

### LOW — Core credential `list()` exposes verifier hashes to callers

Evidence:

- `packages/core/src/service/mcp-credential-service.ts:100-102` returns `McpCredentialRecord[]`, including `secretHash` (`packages/core/src/port/types.ts:236-245`).
- The CLI strips it manually at `packages/cli/src/commands/credential.ts:78-87`, but the service contract itself does not enforce the Detailed Design `CredentialSummary[]` boundary.

Impact: SHA-256 over 256-bit random secrets is not practically reversible, and no current HTTP/MCP route exposes the list. However any future UI/admin caller that serializes the service result can disclose stable bearer verifier material contrary to least privilege.

Fix: make `list()` return a dedicated summary type without `secretHash`; keep raw records private to the persistence/verification path. Add a service-level test, not only a CLI projection test.

## Checked areas with no actionable defect found

- Credential generation uses 32 CSPRNG bytes, a fixed 43-character base64url body, `vcmcp_` prefix, canonical SHA-256 storage, and timing-safe digest comparison (`packages/adapter/src/runtime/mcp-credential-crypto.ts:1-33`).
- Credential rotate is one SQLite transaction: old active→rotating plus new active insert; concurrent rotate/revoke is CAS-scoped, overlap boundary is strict, and verify lazily revokes expired rotating rows (`packages/adapter/src/db/mcp-credential.ts:43-96`).
- MCP bearer failure shape is uniform and browser cookies cannot authenticate MCP (`packages/server/src/middleware/perimeter.ts:84-93`). Host and CORS run before auth/body handling (`packages/server/src/app.ts:57-79`).
- Approval reserve is finally enforced in T1 with exact status, TTL, tool/project/target/revision/digest/hash binding and one CAS (`packages/adapter/src/db/journal.ts:143-193`); consume/release/invalidate transitions are transactionally tied to journal terminal state. Replay and revoke-vs-reserve coverage exists.
- Path syntax rejects absolute/traversal/backslash/NUL forms and the resolver canonicalizes existing symlinks then rechecks containment and purpose (`packages/core/src/domain/path-policy.ts:48-107`, `packages/adapter/src/fs/resolve.ts:63-87`). Serve/read paths go through purpose allowlists. Residual rename/symlink swap race is part of the broader pre-write TOCTOU finding above.
- Backup publication uses temp directory, fsynced 0600 payload/manifest files, manifest and payload hashes, verification before rename, parent fsync, DB manifest linkage, and project scoping (`packages/adapter/src/fs/backup-store.ts:63-169,180-254`). Restore verifies manifest/payload and checks destructive `toHash` before creating a new composite revision (`packages/core/src/usecase/restore-backup.ts:38-144`).
- Tool audit detail recursively redacts standard content/secret keys and absolute-path string values, persists only credential ID, and re-applies redaction at persistence (`packages/core/src/service/tool-audit-service.ts:10-70,86-126`; `packages/adapter/src/db/tool-audit.ts:11-28`). The query logger finding is a separate pre-audit logging path.

## Suggested missing regression cases

1. Credential ID propagation matrix: entry + every pinned revision + latest, both read and destructive tool audit.
2. External-edit destructive races at validation→T1, backup copy, backup verify→first mutation, and between multi-target steps.
3. Backup abort transaction failure returning `recovery_required`, not ordinary `backup_failed`.
4. Untouched expired requested/issued grant cleanup and high-volume approval-request retention.
5. Crash injection between payload delete and `payload_pruned_at` update.
6. Logger redaction for hostile Host, unauthenticated requests, arbitrary token-like query keys, and absolute `path` values.
7. Allowed-origin canonical CORS and credentialed OPTIONS preflight.
8. Initial DB/WAL/SHM permission checks under a permissive umask.
