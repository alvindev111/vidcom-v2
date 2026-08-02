# Review implementation — Spec MCP Server

> Checkout review: `b0830f12a2c2a2fbe3e8c8800cdf7cbd8d1db2e3`  
> Ngày review: 2026-08-02  
> Phạm vi: code đã implement từ `Spec MCP Server — Implementation Checklist`, gồm contracts, 10 tools, dual-era transports, composite persistence/recovery, approval/backup/credential, Hono mount, CLI/admin và test/CI evidence.  
> Phương pháp: 7 agent review độc lập, sau đó findings nghiêm trọng được đối chiếu lại với source, test và runtime probe. Không sửa production code trong phiên review này.

## 1. Kết luận

**Trạng thái đề xuất: NEEDS REVISION — chưa nên giữ claim `Complete`/release-ready.**

Happy path hiện có bằng chứng tốt: full suite, contract gate, golden, typecheck, build và Next runtime smoke đều xanh. Tuy nhiên review tìm thấy:

| Mức | Số finding hợp nhất | Ý nghĩa |
|---|---:|---|
| Critical | 1 | Có đường mất thay đổi ngoài daemon và làm backup destructive không restore được |
| High | 10 | Có race lease/recovery, sai destructive/reference safety, thiếu audit, invalid domain write và operability gap |
| Medium | 24 | Contract/validation/retention/error/test-evidence còn nhiều edge chưa khóa |
| Low | 8 | Hardening, process/doc drift và maintainability |

Điểm đáng chú ý nhất: **423/423 test vẫn pass** trong khi các lỗi dưới đây tồn tại. Vấn đề chính không phải thiếu unit test nói chung, mà là thiếu barrier test tại đúng ranh giới filesystem ↔ SQLite, thiếu success-path contract matrix, và smoke không đi qua đúng executable/host boundary đã claim.

## 2. Release blockers

### C-01 — Optimistic precondition không được enforce tại thời điểm publish filesystem

**Evidence**

- Hash/bytes chỉ được đọc trong `validateCompositePreconditions()` tại [write-authority.ts:236](packages/core/src/service/write-authority.ts#L236).
- Sau T1 và optional backup, code gọi `writeAtomic()`/`deleteAtomic()` tại [write-authority.ts:422](packages/core/src/service/write-authority.ts#L422) mà không re-check live hash.
- Primitive hiện được mô tả rõ là ghi “without checking a write precondition” tại [workspace-fs.ts:144](packages/adapter/src/fs/workspace-fs.ts#L144).
- Backup copy bytes hiện tại nhưng không so với `StepIntent.fromHash`; restore lại bắt payload hash phải bằng `fromHash` tại [restore-backup.ts:73](packages/core/src/usecase/restore-backup.ts#L73).

**Edge gây mất dữ liệu**

1. Client/grant duyệt file ở hash A.
2. T1 persist `fromHash=A`.
3. Editor ngoài daemon đổi file thành B.
4. Mutation ghi đè/xóa B. Backup có thể copy B nhưng revision vẫn ghi A.
5. `restoreBackup()` từ chối chính payload B vì `hash(B) !== fromHash(A)`.

Đây là vi phạm trực tiếp P7 và single-writer contract dành cho external editor. Với write thường, B bị overwrite; với destructive write, B có thể vừa bị xóa vừa không restore qua đường được hỗ trợ.

**Remediation bắt buộc**

- Thiết kế primitive capture/swap có CAS tại publish boundary: stage output, move target thực tế vào rollback slot, hash slot, chỉ publish nếu đúng `fromHash`.
- Backup phải lấy từ chính captured slot và verify với intent đã persist.
- Dùng cùng primitive cho write, delete, rollback và recovery.
- Thêm real-filesystem barrier tests tại validation→T1, T1→backup và backup→publish.

Raw evidence: [persistence-recovery-review.md](mcp-server-review-raw/persistence-recovery-review.md), [security-approval-review.md](mcp-server-review-raw/security-approval-review.md).

### H-01 — Lease có thể đổi chủ sau check nhưng trước T1

`mutateComposite()` chỉ kiểm lease trước/sau in-process mutex tại [write-authority.ts:174](packages/core/src/service/write-authority.ts#L174). `beginComposite()` không nhận `leaseId`, không kiểm lease và project gate atomically trong T1. Hai process có mutex riêng; daemon A có thể pass check, bị pause, lease hết hạn và bị B steal, rồi cả A lẫn B cùng mở journal/ghi.

**Fix**: T1 phải kiểm exact lease owner + expiry + unresolved gate trong cùng SQLite transaction trước insert. Thêm two-connection barrier test cho lease handover.

Raw evidence: [persistence-recovery-review.md](mcp-server-review-raw/persistence-recovery-review.md).

### H-02 — Recovery classify filesystem rồi settle DB trên snapshot đã stale

Recovery đọc/classify target tại [reconcile-composite-mutation.ts:80](packages/core/src/usecase/reconcile-composite-mutation.ts#L80), sau đó commit/abort SQLite mà không khóa hoặc revalidate filesystem. External edit giữa classify và T2 có thể làm DB/audit công bố `toHash` cũ, consume grant và mở gate trong khi file thực tế đã là C.

**Fix**: recovery phải dùng cùng capture/CAS primitive với normal write; mismatch giữ gate/orphan thay vì settle. Bổ sung startup barrier test cho edit giữa classify và T2.

Raw evidence: [persistence-recovery-review.md](mcp-server-review-raw/persistence-recovery-review.md).

### H-03 — Recovery có thể ghi workspace B dù process chỉ giữ lease workspace A

Startup chỉ acquire lease cho workspace được chọn tại [startup.ts:99](packages/cli/src/startup.ts#L99), nhưng reconciliation duyệt journal global. `resolveProjectRef` fallback sang `project_registry.workspace_root` bất kỳ tại [composition-root.ts:135](packages/cli/src/composition-root.ts#L135). Vì vậy process A có thể rollback journal của B mà không sở hữu lease B, song song với daemon B.

**Fix**: scope reconciliation theo workspace đang lease; targeted recovery phải resolve journal trước rồi acquire đúng lease của workspace đó. Không cho runtime-scoped resolver fallback ra ngoài injected root.

Raw evidence: [cli-operability-review.md](mcp-server-review-raw/cli-operability-review.md).

### H-04 — Backup failure có thể để journal `pending`/grant `reserved` nhưng trả `backup_failed`

Hai nhánh backup lỗi tại [write-authority.ts:385](packages/core/src/service/write-authority.ts#L385) gọi `abortComposite(...).catch(() => {})`, nuốt abort failure và luôn trả `backup_failed`. Project sau đó bị recovery gate nhưng caller không nhận `journalId` hoặc hướng dẫn recovery.

**Fix**: dùng chung `abortOrReconcile`; chỉ trả `backup_failed` khi abort đã terminal, ngược lại trả `recovery_required` với journal/phase.

Raw evidence: [persistence-recovery-review.md](mcp-server-review-raw/persistence-recovery-review.md), [security-approval-review.md](mcp-server-review-raw/security-approval-review.md).

### H-05 — `delete_file` bỏ sót nested relative references và toàn bộ root track

Reference guard tại [file-deletion.ts:32](packages/core/src/usecase/file-deletion.ts#L32) chỉ so path canonical với raw `scene.src`, raw `media.src`/URL và `scene.elements.src`; không kiểm `rootTrack`. Parser giữ `<img src="../assets/logo.svg">` dưới dạng raw relative string tại [parse.ts:108](packages/adapter/src/hyperframes/parse.ts#L108).

Repro đã xác nhận: scene `compositions/s.html` tham chiếu `../assets/logo.svg`, nhưng `prepareFileDeletion("assets/logo.svg")` trả `ok:true`. Sau approval, file đang được composition dùng vẫn bị xóa.

**Fix**: parser/model expose một canonical project-relative reference set có owner file; deny delete dựa trên tập đó, bao gồm root track và nested scenes.

Raw evidence: [registry-tools-review.md](mcp-server-review-raw/registry-tools-review.md).

### H-06 — `create_scene` persist được duration `0`, âm và overflow

Schema chỉ kiểm finite tại [mcp.ts:111](packages/contracts/src/mcp.ts#L111), đúng với rule schema/domain separation. Nhưng Core lấy duration và ghi thẳng tại [project-writes.ts:333](packages/core/src/usecase/project-writes.ts#L333), không gọi `validateSceneTiming()` như `setSceneTiming()`.

Input `duration: 0` hoặc `-1` đi qua public tool, tạo mount/source/narration và revision có timing invalid. Số finite cực lớn còn có thể làm `start + duration` thành `Infinity` trước khi output validation báo lỗi.

**Fix**: enforce invariant trong Core trước `applyOps()`/T1; test 0, âm, overflow và assert không journal/file mutation.

Raw evidence: [registry-tools-review.md](mcp-server-review-raw/registry-tools-review.md).

### H-07 — Modern destructive call tạo approval request nhưng không có terminal tool audit

Registry chuẩn bị audit trước handler tại [registry.ts:113](packages/mcp/src/registry/registry.ts#L113), nhưng rethrow `InputRequiredSignal` tại [registry.ts:139](packages/mcp/src/registry/registry.ts#L139) trước toàn bộ terminal audit. Approval row đã được tạo; transport chỉ map signal sang MRTR và không audit.

Legacy có audit vì trả `approval_required` như `Result`; modern không có. Điều này vi phạm “mọi tool call được audit”.

**Fix**: coi `input_required` là terminal outcome của round hiện tại và ghi caller-owned audit trước transport mapping.

Raw evidence: [registry-tools-review.md](mcp-server-review-raw/registry-tools-review.md).

### H-08 — Pinned/latest HTTP làm rơi `authInfo`; audit mất `credentialId`

Accepted branch tại [http.ts:67](packages/mcp/src/http.ts#L67) gọi `inner(request)` thay vì `inner(request, options)`. Hono đã verify bearer đúng, nhưng Registry nhận `credentialId=null` trên `/api/mcp/<revision>` và `/api/mcp/latest`.

Runtime repro:

```text
{"key":"","credentialId":"credential-proof"}
{"key":"2025-06-18","credentialId":null}
```

Exact modern và `latest` có cùng lỗi. Đây là lỗi attribution/audit, không phải auth bypass.

**Fix**: forward `options`; thêm Hono→real SDK→Registry audit matrix cho entry, mọi exact revision và latest.

Raw evidence: [protocol-transport-review.md](mcp-server-review-raw/protocol-transport-review.md), [spec-trace-review.md](mcp-server-review-raw/spec-trace-review.md), [test-ci-runtime-review.md](mcp-server-review-raw/test-ci-runtime-review.md).

### H-09 — Cleanup short-circuit làm rò watcher/lease/DB

`runtime.stop()` tại [startup.ts:164](packages/cli/src/startup.ts#L164) await tuần tự; listener close lỗi làm bỏ qua background stop, lease release và DB destroy. Repro với listener giả ném lỗi để lại lease count `1`.

**Fix**: unwind stack/independent `finally`, luôn thử mọi cleanup và ném `AggregateError` sau cùng; test lỗi từng cleanup hook.

Raw evidence: [cli-operability-review.md](mcp-server-review-raw/cli-operability-review.md).

### H-10 — Claim “AI host spawn `vidcom mcp`” chưa đúng với executable hiện tại

Bin [vidcom.mjs](packages/cli/bin/vidcom.mjs) có Git mode `100644`, checkout không có `node_modules/.bin/vidcom`, và wrapper phụ thuộc `tsx` + source `.ts`. E2E không spawn `vidcom`; nó chạy `node <absolute-source-wrapper>`. Lệnh trực tiếp `./packages/cli/bin/vidcom.mjs` trả permission denied.

Phase 4 mới chịu trách nhiệm SEA là hợp lý, nhưng Phase 2 không nên claim executable/AI-host command mà smoke không dùng đúng boundary đó.

**Fix**: ít nhất track `100755`, tạo/link command trong artifact test và spawn đúng resolved `vidcom`; hoặc sửa AC/docs để nêu chính xác source-checkout command.

Raw evidence: [cli-operability-review.md](mcp-server-review-raw/cli-operability-review.md), [test-ci-runtime-review.md](mcp-server-review-raw/test-ci-runtime-review.md).

## 3. Medium findings và edge-case backlog

| ID | Finding | Evidence chính | Hướng xử lý |
|---|---|---|---|
| M-01 | `set_scene_timing` cho payload không có field timing nhưng vẫn serialize/churn revision | [mcp.ts:125](packages/contracts/src/mcp.ts#L125), [project-writes.ts:146](packages/core/src/usecase/project-writes.ts#L146) | Schema refine + Core no-op guard |
| M-02 | `set_text` luôn trả `narrationStale=true` kể cả không có narration; read sau đó trả false | [project-writes.ts:231](packages/core/src/usecase/project-writes.ts#L231), [mcp.ts:150](packages/contracts/src/mcp.ts#L150) | Sửa design contract thành boolean/state; test narration absent |
| M-03 | Output validation chạy sau commit có thể trả `internal` dù mutation/audit đã success | [registry.ts:139](packages/mcp/src/registry/registry.ts#L139), [journal.ts:378](packages/adapter/src/db/journal.ts#L378) | Thiết kế response-finalization semantics |
| M-04 | `WriteEnvelope.fileHashes` chấp nhận absolute path key | [mcp.ts:34](packages/contracts/src/mcp.ts#L34) | Enforce canonical `RelPath` keys |
| M-05 | Tool descriptions thiếu “khi không dùng”, nguồn precondition và error guidance bắt buộc | [write-tools.ts:29](packages/mcp/src/registry/write-tools.ts#L29), [read-tools.ts:29](packages/mcp/src/registry/read-tools.ts#L29) | Nâng description + golden contract |
| M-06 | Audit model thiếu duration và revision before/after theo steering | [types.ts:52](packages/core/src/port/types.ts#L52) | Thêm timing/revision fields hoặc cập nhật steering bằng quyết định có chủ đích |
| M-07 | Một project parse lỗi làm `list_projects` fail toàn bộ; danh sách còn unbounded/`Promise.all` | [project-reads.ts:107](packages/core/src/usecase/project-reads.ts#L107) | Per-project error isolation + pagination/limit |
| M-08 | Referenced source thiếu hash làm `get_project_context` throw `internal` thay vì diagnostic | [project-reads.ts:61](packages/core/src/usecase/project-reads.ts#L61) | Trả diagnostic/bounded error, không throw |
| M-09 | Exact-pin wrapper trả `-32022` trước SDK `Content-Type` validation | [http.ts:49](packages/mcp/src/http.ts#L49) | Để SDK validation ladder chạy trước pin mismatch |
| M-10 | Query logger chỉ redact `t`, có thể log token key khác và absolute path trước auth | [perimeter.ts:33](packages/server/src/middleware/perimeter.ts#L33), [app.ts:57](packages/server/src/app.ts#L57) | Log pathname only hoặc allowlist query keys |
| M-11 | `requested`/`issued` grants hết TTL nhưng không được transition/cleanup nếu không bị chạm lại | [approval-grants.ts:119](packages/adapter/src/db/approval-grants.ts#L119) | `expireDue(now)` trước cleanup |
| M-12 | Backup payload prune xóa filesystem trước DB mark, không crash-consistent | [backup-store.ts:277](packages/adapter/src/fs/backup-store.ts#L277) | Tombstone/rename → durable state → delete |
| M-13 | Startup prune backup trước recovery; pending destructive journal có thể mất undo trước khi settle | [startup.ts:121](packages/cli/src/startup.ts#L121) | Recovery trước retention; exempt unresolved manifests |
| M-14 | Rollback bytes bị duplicate trong `mutation_step`, `revision_step`, `revision_blob` và BackupStore | [journal.ts:212](packages/adapter/src/db/journal.ts#L212) | Content-addressed payload store + retention/compaction |
| M-15 | stdin EOF/host crash không dừng MCP; orphan tiếp tục renew lease | [mcp.ts:109](packages/cli/src/commands/mcp.ts#L109), [stdio.ts:17](packages/mcp/src/stdio.ts#L17) | Expose transport close lifecycle; race EOF/signal |
| M-16 | Signal handler cài sau startup và gỡ trước cleanup xong | [mcp.ts:116](packages/cli/src/commands/mcp.ts#L116) | Install abort gate trước startup; giữ handler đến settle |
| M-17 | Explicit workspace sai âm thầm fallback active/cwd | [workspace-selection.ts:41](packages/cli/src/workspace-selection.ts#L41) | Explicit invalid phải fail fast |
| M-18 | Invalid backup ID vẫn dựng full writer runtime và chạy reconciliation/cleanup trước khi reject | [backup.ts:91](packages/cli/src/commands/backup.ts#L91) | Validate manifest/target trước, dùng targeted runtime tối thiểu |
| M-19 | Infra errors in raw absolute path; `node:sqlite` warning phá one-line stderr contract | [main.ts:186](packages/cli/src/main.ts#L186) | Stable redacted error + production warning policy |
| M-20 | Contract matrix chỉ success `list_projects`; 9 tools chủ yếu chứng minh shared early error | [contract-matrix.test.ts:19](tests/mcp/contract-matrix.test.ts#L19), [support.ts:63](tests/mcp/support.ts#L63) | Success-path matrix cho đủ tool phù hợp qua 2×2 |
| M-21 | “Real AI host” thực tế là SDK clients trong Vitest, không phải Claude Code/Codex binary | [mcp-stdio-host.test.ts:8](tests/e2e/mcp-stdio-host.test.ts#L8) | Chạy host binary thật hoặc sửa DoD/claim |
| M-22 | Verification Matrix có command trỏ file test không tồn tại ở Phase C/D/E/G/H/J | [spec-mcp-server-implementation-checklist.md:182](llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-implementation-checklist.md#L182) | Cập nhật exact commands và rerun phase gates |
| M-23 | Approval trace tự mâu thuẫn: v6 vừa Approved vừa “chờ tái xác nhận”; checklist còn dòng Pending Confirmation | [spec-mcp-server-detailed-goal.md:423](llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-detailed-goal.md#L423), [spec-mcp-server-implementation-checklist.md:751](llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-implementation-checklist.md#L751) | Chốt một canonical approval fact và đồng bộ docs |
| M-24 | Remote CI chưa verify được trên exact current HEAD `b0830f1`; docs chỉ có run cho commit cũ hơn | [spec-mcp-server-complete.md:106](llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-complete.md#L106) | Verify live CI trên exact HEAD hoặc ghi rõ evidence gap |

## 4. Low findings / hardening

| ID | Finding |
|---|---|
| L-01 | Allowed CORS origin được reflect từ request dù đã qua allowlist; lệch steering “không reflect Origin”. |
| L-02 | SQLite chứa credential/audit được chmod sau khi open/create; còn cửa sổ permission nhỏ, app-data dir không explicit `0700`. |
| L-03 | Core credential `list()` trả record có `secretHash`; CLI chỉ strip thủ công. |
| L-04 | MCP text content dùng `JSON.stringify` thường, chưa canonical như Execution Contract. |
| L-05 | Named `test:mcp-contract` không chứa chính contract-matrix, negative matrix và revision-pin; hiện được full suite cứu. |
| L-06 | `implementation-notes.html` ghi phase C/D/E trước B, làm history khó audit dù Execution Log đúng thứ tự. |
| L-07 | `--overlap-ms` nhận safe integer ngoài miền `Date`, dẫn tới RangeError/exit 1 thay vì input error. |
| L-08 | Next runtime smoke chỉ chạm legacy entry `tools/list`; cleanup chờ tối đa 5 giây nhưng không fail nếu child chưa thoát. |

Chi tiết đầy đủ, repro và fix nằm trong raw files ở §7.

## 5. Test và runtime evidence đã chạy lại

| Gate | Kết quả hiện tại |
|---|---|
| `rtk bun run typecheck` | Pass |
| `rtk bun run lint` | Pass, 0 error / 10 warning ngoài MCP surface |
| `rtk bun run test` | **66 files / 423 tests pass** |
| `rtk bun run test:mcp-contract` | **6 files / 51 tests pass** |
| `rtk bun run test:golden` | **6 files / 22 tests pass** |
| `rtk bun run build` | Pass |
| `rtk bun run test:runtime-smoke` sau build | Pass: MCP bearer entry + SSE resume |
| Persistence focused matrix | **14 files / 112 tests pass** |
| Registry/tools focused | **3 files / 27 tests pass** |
| Protocol focused | **9 files / 37 tests pass** |
| CLI focused | **3 files / 36 tests pass** |
| `git diff --check` trên raw artifacts | Pass |

Các gate xanh chứng minh happy path và nhiều transaction invariant nội bộ. Chúng **không** phủ định findings race/crash/host-boundary ở trên.

Remote CI trên exact current HEAD chưa được xác minh trong phiên này: GitHub CLI/API trả 404. Source code không đổi sau ship commit được ghi trong docs, nhưng Definition of Done yêu cầu evidence trên exact commit, nên đây là evidence gap chứ chưa kết luận CI fail.

## 6. Những phần đã kiểm và chưa thấy blocker mới

- Một Tool Registry/factory duy nhất phục vụ hai era và hai transport; deterministic tool order hiện đúng.
- Modern/legacy result stamping, cache hint private, resource error split và revision constants có contract/golden coverage.
- T1 reserve grant + journal + ordered steps nằm trong một SQLite transaction; T2b/T2c gom revision/audit/event/grant/journal atomically trong DB.
- Approval reserve có CAS theo status/TTL/tool/project/target/revision/digest/hash; replay và revoke-vs-reserve đã có coverage.
- Credential dùng 32 CSPRNG bytes, canonical SHA-256, timing-safe compare; rotate/revoke paths có SQLite tests.
- Path resolver chặn absolute/traversal/NUL, canonicalize symlink và re-check containment/purpose. Finding còn lại nằm ở race sau validation và semantic reference graph, không phải basic traversal.
- BackupStore happy path dùng temp, fsync, hash, verify, rename; restore verify manifest/payload. Lỗi nằm ở orchestration/race/retention quanh primitive.
- Full task count đúng 140, task ID không trùng và không có `.skip/.todo/.only` trong surface review.
- Packaged Node SEA và authenticated daemon IPC được ghi carry-over Phase 4; review không coi việc chưa có SEA là bug Phase 2. Finding executable chỉ phản ánh claim/smoke hiện tại.

## 7. Raw reports của từng agent

Mỗi file giữ nguyên findings, command output, areas checked và reasoning riêng của agent:

1. [Spec / traceability review](mcp-server-review-raw/spec-trace-review.md)
2. [Registry / contracts / 10 tools review](mcp-server-review-raw/registry-tools-review.md)
3. [Protocol / transport review](mcp-server-review-raw/protocol-transport-review.md)
4. [Persistence / recovery review](mcp-server-review-raw/persistence-recovery-review.md)
5. [Security / approval / credential review](mcp-server-review-raw/security-approval-review.md)
6. [CLI / operability review](mcp-server-review-raw/cli-operability-review.md)
7. [Test / CI / runtime review](mcp-server-review-raw/test-ci-runtime-review.md)

Tổng raw artifact: **1.525 dòng**.

## 8. Thứ tự remediation đề xuất

1. **Dừng release** và thiết kế lại filesystem mutation primitive cho CAS/capture tại publish boundary; dùng cho write/delete/rollback/recovery.
2. Đưa lease + gate check vào T1 transaction; scope recovery đúng workspace/lease; khóa classify→settle race.
3. Sửa backup abort/reconcile semantics và reorder recovery trước retention.
4. Sửa 4 public MCP correctness blockers: delete reference graph, create duration invariant, modern input-required audit, pinned authInfo forwarding.
5. Sửa CLI cleanup/EOF/signal/executable boundary.
6. Bổ sung success-path 2 era × 2 transport matrix và các barrier/failure-injection tests nêu trên.
7. Chạy lại toàn bộ Verification Matrix bằng command tồn tại, build + runtime smoke, AI-host evidence đúng boundary, và remote CI trên exact commit.
8. Chỉ sau đó đồng bộ Design/Checklist/Main Spec và quyết định lại trạng thái `Complete`.
