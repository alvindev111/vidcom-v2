# Raw review — Persistence, composite write và recovery

Phạm vi review read-only: checklist Phase B–F, H–K và P liên quan migration SQLite, journal T1/T2a/T2b/T2c, `WriteAuthority`, approval grant, backup/restore, startup/admin recovery, durable audit và concurrency. Ngoài file raw này, không sửa production code, test, spec hay checklist.

## Kết luận nhanh

Các transaction SQLite nội bộ được tách khá rõ và focused suite hiện xanh, nhưng persistence boundary giữa SQLite và filesystem vẫn có những race có thể mất thay đổi bên ngoài hoặc công bố lịch sử sai. Blocker nặng nhất là optimistic precondition chỉ được đọc trước T1 rồi `writeAtomic`/`deleteAtomic` không CAS; một editor ngoài daemon chen vào có thể bị ghi đè, và ở destructive flow backup có thể giữ bytes mới nhưng `restoreBackup` lại từ chối chúng vì journal giữ hash cũ. Ngoài ra còn lỗ lease-handover trước T1, nhánh backup-failure nuốt lỗi terminal transaction, recovery observation-to-settlement race và retention không thu hồi approval request/grant hết hạn bị bỏ quên.

Review trên checkout `b0830f12a2c2a2fbe3e8c8800cdf7cbd8d1db2e3`.

## Findings theo severity

### CRITICAL — External edit chen sau precondition có thể bị overwrite; destructive backup trở thành không restore được

**Evidence**

- `WriteAuthority.validateCompositePreconditions()` đọc bytes/hash một lần và chụp `previousContent` tại `packages/core/src/service/write-authority.ts:236-345`.
- Sau đó T1 được ghi tại `packages/core/src/service/write-authority.ts:372-383`; nếu destructive thì backup đọc lại target hiện tại tại `packages/core/src/service/write-authority.ts:385-418`; cuối cùng các step ghi/xóa tại `packages/core/src/service/write-authority.ts:422-426`.
- `WorkspaceFs.writeAtomic()` được mô tả tường minh là “without checking a write precondition” và chỉ rename đè target tại `packages/adapter/src/fs/workspace-fs.ts:144-146`; `deleteAtomic()` cũng unlink không CAS tại `packages/adapter/src/fs/workspace-fs.ts:160-162` và `packages/adapter/src/fs/atomic-delete.ts:7-12`.
- Backup store hash/copy bytes mà nó đọc ở thời điểm backup tại `packages/adapter/src/fs/backup-store.ts:127-160`, nhưng không đối chiếu hash đó với `StepIntent.fromHash` đã persist.
- `restoreBackup()` bắt buộc backup payload hash phải bằng `revision_step.fromHash`; lệch thì trả `backup_failed` tại `packages/core/src/usecase/restore-backup.ts:73-82,125-133`.
- Test concurrency hiện chỉ chạy hai request qua cùng một `WriteAuthority` mutex tại `tests/adapter/composite-write-authority.test.ts:122-132` và `tests/adapter/concurrency-lease.test.ts:80-113`; không có editor/process ngoài daemon chen giữa read-hash và rename.

**Race / reproduction scenario**

1. File đang là `A`; client gửi expected hash của `A` và destructive grant bind với hash `A`.
2. Authority validate, persist T1 với `fromHash=hash(A)` và `previousContent=A`.
3. Editor ngoài daemon ghi `B` trước `BackupStore.create()` hoặc trước filesystem step.
4. Backup copy `B`, rồi authority xóa/ghi đè target và T2 commit revision có `fromHash=hash(A)`.
5. Supported restore đọc payload `B`, thấy `hash(B) !== fromHash(A)` và từ chối. Thay đổi `B` đã bị xóa; backup có bytes nhưng application không cho restore. Với write không backup, `B` bị overwrite thẳng.

**Impact**

- Vi phạm P7/mọi-write precondition và lời hứa “người dùng vẫn sửa project bằng công cụ ngoài — thay đổi đó được phát hiện, không bị ngăn”.
- Có thể mất source/narration do người dùng vừa sửa, trong khi mutation/audit vẫn báo success và revision chứa trạng thái trước đó.
- Destructive backup không còn là recovery path hợp lệ đúng lúc cần nhất.

**Fix đề xuất**

- Không tách “đọc expected hash” và “thay target” bằng một `WorkspacePort.writeAtomic()` không điều kiện. Cần primitive mutation giữ lại target thực tế ngay tại swap boundary: stage output, move/swap target hiện tại sang journal-owned rollback slot, hash slot đó và chỉ publish khi nó đúng `fromHash`; mismatch thì restore slot và trả `write_conflict` mà không mất bytes ngoài.
- Persist rollback-slot/actual-from metadata trước publish để crash recovery biết cả target lẫn slot. Với delete cũng move sang rollback slot thay vì unlink thẳng.
- Backup phải được tạo từ chính captured rollback slot và assert mọi manifest entry khớp step `fromHash`; mismatch phải abort trước destructive publish.
- Thêm real filesystem race test có barrier đúng giữa validation/T1/backup/rename; assert external bytes còn nguyên và không có committed revision.

### HIGH — Lease có thể đổi chủ sau check nhưng trước T1; hai authority khác process vẫn có thể cùng mở journal và ghi

**Evidence**

- `mutateComposite()` chỉ check lease trước và ngay sau khi vào mutex tại `packages/core/src/service/write-authority.ts:174-199`; sau validation không check lại trước T1/backup/filesystem/T2.
- `ProjectMutex` là state trong từng `WriteAuthority` instance (`packages/core/src/service/write-authority.ts:168-170`), không khóa cross-process.
- Lease TTL là 30 giây và daemon khác được steal row hết hạn tại `packages/adapter/src/db/lease.ts:8-9,20-40`.
- `MutationJournal.beginComposite()` tại `packages/adapter/src/db/journal.ts:121-227` không nhận/check `leaseId`, và cũng không re-check project gate bên trong cùng transaction trước khi insert T1.
- Test lease chỉ steal trước khi gọi stale authority, nên stale authority fail ở check đầu tại `tests/adapter/concurrency-lease.test.ts:55-93`; không test lease mất trong validation/backup.

**Race / reproduction scenario**

1. Daemon A pass check ở line 182 rồi kẹt ở parse/read/hash hoặc event loop; renewal fail và TTL hết.
2. Daemon B acquire lease mới, pass gate và có thể bắt đầu T1.
3. A tiếp tục từ validation sang `beginComposite`; T1 không biết lease đã mất và không kiểm pending journal mới của B.
4. A và B có mutex khác process, nên cả hai có thể apply/commit cùng target. Revision chain và final bytes phụ thuộc thứ tự race, không còn single-writer.

**Fix đề xuất**

- T1 phải là authority cuối cho cả lease và gate: truyền lease/workspace identity vào journal port, trong transaction kiểm exact `lease_id`, `expires_at >= transactionNow` và không có unresolved journal không được bypass trước insert.
- Re-check lease sau mọi bước dài (đặc biệt validation và backup) chỉ là defense-in-depth; không thay cho check atomic trong T1.
- Thêm two-database-connection test với barrier: A pass initial check, clock vượt TTL, B steal + T1, sau đó nhả A; assert A không tạo journal/không chạm disk.

### HIGH — Backup unavailable/fail có thể để T1 pending nhưng API trả `backup_failed`, không inline reconcile và không báo recovery gate

**Evidence**

- Khi thiếu backup adapter, code gọi `abortComposite(...).catch(() => {})` rồi trả `BackupFailed` tại `packages/core/src/service/write-authority.ts:385-394`.
- Khi `create`/`verify`/`attachBackup` lỗi, code cũng swallow abort failure và trả `BackupFailed` tại `packages/core/src/service/write-authority.ts:395-418`.
- Nhánh filesystem-step failure xử lý T2a fail đúng hơn: chạy một inline reconcile và trả `recovery_required` khi journal còn pending tại `packages/core/src/service/write-authority.ts:427-465`.
- Focused tests có T2a failure sau rollback tại `tests/core/write-authority.test.ts:470-492`, nhưng không có T2a failure trong backup-error branch; test backup success duy nhất ở `tests/core/write-authority.test.ts:358-382`.

**Crash/failure scenario**

1. T1 đã persist và destructive grant đã `reserved`.
2. Backup store fail hoặc `attachBackup` fail.
3. SQLite trigger/disk error làm `abortComposite` fail.
4. Code nuốt lỗi, trả `backup_failed`; journal vẫn `pending`, grant vẫn `reserved`, audit vẫn journal-owned và mọi write kế tiếp bị gate.

**Impact**

- Caller không nhận `journalId`/`recovery_required`, nên không biết phải chạy recovery inspect/reconcile.
- Vi phạm E.6/E.10 và design step 9: mọi T2a/T2b/T2c fail phải đúng một inline reconcile.

**Fix đề xuất**

- Dùng chung một helper `abortOrReconcile(journalId, reason, grant)` cho backup failure và step failure.
- Chỉ trả `backup_failed` khi abort đã terminal; nếu abort/reconcile không terminal, trả `recovery_required { journalId, phase:"backup-abort" }`.
- Thêm failure injection cho cả `backups.create`, `backups.verify`, `attachBackup` × `abortComposite` fail, assert exact terminal/gate/audit ownership.

### HIGH — Recovery quyết định bằng snapshot hash rồi settle DB mà không khóa/revalidate filesystem; gate có thể mở trên trạng thái đã đổi

**Evidence**

- Recovery đọc/classify từng target tại `packages/core/src/usecase/reconcile-composite-mutation.ts:80-96`.
- Sau khi quyết định, nhánh all-landed gọi thẳng `commitComposite` tại `packages/core/src/usecase/reconcile-composite-mutation.ts:117-136`; nhánh none-landed gọi thẳng abort tại lines 139-151.
- `commitComposite()` chỉ transaction SQLite; không đọc lại filesystem tại `packages/adapter/src/db/journal.ts:275-441`.
- Startup chạy reconciliation trước watcher tại `packages/cli/src/startup.ts:121-158`, nên external edit xảy ra trong cửa sổ này không chắc tạo watcher event sau đó.

**Race / reproduction scenario**

- Journal all-landed; recovery observe đúng `toHash`.
- Editor ngoài daemon đổi target thành `C` trước T2b.
- Recovery vẫn commit revision/toHash cũ, consume grant và gỡ gate. File thực tế là `C`, DB/audit nói mutation đã commit đúng `toHash`.
- Tương tự, journal none-landed có thể bị abort/gỡ gate sau khi target đổi thành unknown giữa observe và T2a.

**Fix đề xuất**

- Recovery cần cùng filesystem capture/swap primitive với normal write; trước terminal transaction phải chứng minh target vẫn đúng observation, và mọi thay đổi chen vào phải được giữ lại thay vì overwrite.
- Ít nhất, re-read toàn bộ hashes ngay trước T2 và sau T2; mismatch giữ/orphan gate. Tuy nhiên double-read đơn thuần vẫn còn race nhỏ, nên durable rollback-slot protocol mới là fix chắc chắn.
- Bắt đầu watcher/dirty tracking trước reconciliation hoặc có startup rescan sau watcher start; test barrier cho edit giữa classify và settle.

### MEDIUM — Approval request và issued grant hết hạn bị bỏ quên không bao giờ chuyển terminal, nên không bao giờ được cleanup

**Evidence**

- Mỗi destructive call thiếu grant tạo row mới tại `packages/mcp/src/registry/destructive-tools.ts:29-54,96-105,133-142`.
- `ApprovalService.issue()` phát hiện request hết hạn rồi return ngay tại `packages/core/src/service/approval-service.ts:73-80`, nên không gọi adapter `issue()` — nơi duy nhất lazy-update requested→expired tại `packages/adapter/src/db/approval-grants.ts:83-97`.
- `planReserve()` cũng return `approval_expired` cho issued grant hết hạn tại `packages/core/src/service/approval-service.ts:100-110`, không persist status `expired`; vì vậy T1 lazy expiry ở journal không bao giờ được gọi.
- Startup cleanup chỉ xóa status `consumed|expired|revoked|invalidated` tại `packages/adapter/src/db/approval-grants.ts:119-130`; `requested`/`issued` hết hạn vẫn tồn tại vô hạn.

**Impact / edge case**

- Agent hoặc authenticated client có thể lặp `delete_scene`/`delete_file` thiếu grant để tăng `approval_grant` không giới hạn; TTL 10/5 phút không tạo retention thực tế.
- DB/list/admin state tích tụ theo thời gian dù request đã vô dụng.

**Fix đề xuất**

- Thêm repository transition `expireDue(now)` chạy trong startup cleanup và trước read/issue/planReserve, atomically đổi `requested|issued` quá hạn sang `expired`.
- Hoặc mở rộng cleanup query xóa trực tiếp expired-by-time `requested|issued` sau retention, nhưng cần giữ semantics/audit rõ.
- Thêm real SQLite test tạo abandoned requested + issued, advance clock qua TTL + retention, startup cleanup phải xóa; reserved/unresolved vẫn giữ.

### MEDIUM — Previous asset bytes bị nhân bản vô hạn trong SQLite dù đã có BackupStore; delete narration lớn có thể làm đầy đĩa và tự đẩy mutation vào orphan

**Evidence**

- Validation đọc toàn bộ bytes và gắn `previousContent` vào mỗi step tại `packages/core/src/service/write-authority.ts:281-330`.
- T1 copy blob vào `mutation_step` tại `packages/adapter/src/db/journal.ts:212-222`.
- T2b copy lại blob vào `revision_step` tại `packages/adapter/src/db/journal.ts:320-332`; mutation một step còn copy thêm lần nữa vào deprecated `revision_blob` tại lines 352-357.
- Destructive flow đồng thời copy source vào filesystem BackupStore tại `packages/adapter/src/fs/backup-store.ts:127-160`.
- `deleteScene` có thể đưa narration JSON/WAV vào delete steps tại `packages/core/src/usecase/scene-deletion.ts:228-247`; không có retention/prune cho `mutation_step.previous_content`/`revision_step.previous_content`.

**Impact**

- Một WAV lớn có thể tồn tại ở backup + journal + revision (và một-step có thêm revision_blob); repeated delete/restore làm `vidcom.sqlite` tăng không giới hạn.
- ENOSPC có thể xảy ra ngay giữa T1/backup, khiến thao tác destructive fail/orphan và làm toàn app-data DB khó vận hành.
- Backup payload retention 30 ngày không thật sự giảm retention bytes nếu cùng payload còn vĩnh viễn trong SQLite revision blobs.

**Fix đề xuất**

- Đặt ngưỡng inline blob nhỏ; payload lớn dùng content-addressed app-data object/backup reference có fsync/hash và FK/refcount, không duplicate bytes trong SQLite.
- Có retention/compaction rõ cho revision payload nhưng giữ metadata/hash/audit; VACUUM policy phải explicit và không chạy trong request.
- Thêm test với narration asset lớn đo DB growth và failure injection ENOSPC trước/sau T1.

### MEDIUM — Startup prune backup trước recovery có thể làm all-landed destructive mutation được commit lần đầu sau khi backup đã hết khả năng restore

**Evidence**

- Startup gọi `backups.prunePayloads()` trước `reconcileCompositeMutations()` tại `packages/cli/src/startup.ts:121-138`.
- `prunePayloads()` chọn mọi manifest theo `created_at`, không loại manifest đang gắn journal `pending|orphaned`, rồi xóa payload trước khi đánh `payload_pruned_at` tại `packages/adapter/src/fs/backup-store.ts:277-299`.
- Recovery all-landed sau đó vẫn commit và link revision tại `packages/core/src/usecase/reconcile-composite-mutation.ts:119-133` và `packages/adapter/src/db/journal.ts:359-365`.

**Crash timeline**

1. Destructive mutation publish/attach backup, xóa target, crash trước T2b.
2. Máy/app không chạy lâu hơn retention 30 ngày.
3. Startup đầu tiên prune payload vì tuổi `created_at`, rồi recovery thấy all-landed và commit mutation.
4. User lần đầu thấy operation terminal nhưng `backup restore` đã trả `backup_expired`; undo chính thức không còn.

**Fix đề xuất**

- Exempt backup được tham chiếu bởi journal unresolved khỏi prune; chỉ bắt đầu retention sau terminal revision link hoặc dùng `settled_at`/linked time.
- Chạy recovery trước retention cleanup, rồi prune theo terminal metadata. Nếu recovery vẫn pending/orphaned, giữ payload bất kể tuổi.
- Đổi prune thành mark/rename-to-trash + DB transaction trước physical delete để crash giữa `rm` và UPDATE không để metadata nói còn payload.

## Verification đã chạy

```text
rtk bun run test -- \
  tests/adapter/mcp-database-migration.test.ts \
  tests/adapter/composite-journal.test.ts \
  tests/core/write-authority.test.ts \
  tests/adapter/composite-write-authority.test.ts \
  tests/core/composite-recovery.test.ts \
  tests/adapter/composite-recovery-persistence.test.ts \
  tests/adapter/approval-grants.test.ts \
  tests/adapter/backup-store.test.ts \
  tests/adapter/backup-restore.test.ts \
  tests/adapter/project-destructive-usecases.test.ts \
  tests/core/tool-audit-policy.test.ts \
  tests/adapter/tool-audit-persistence.test.ts \
  tests/mcp/contract-matrix.test.ts \
  tests/mcp/negative-contract-matrix.test.ts
```

Kết quả: **14/14 files pass, 112/112 tests pass**, exit 0. Các finding trên là crash/race/retention gaps chưa được suite này mô phỏng, không phải test fail hiện hữu.

## Các vùng đã kiểm và chưa thấy blocker mới

- Migration fresh/reopen/Phase-1 preservation, FK check, file mode và rollback refusal/safe path đều có real SQLite coverage; focused tests pass.
- T1 reserve grant + journal + ordered steps nằm cùng SQLite transaction; reserve-vs-revoke/two-reserve CAS được test và không thấy split-brain trong transaction nội bộ.
- T2b gom revision, revision steps, entity state, mutation/tool audit, event, backup link, grant consume và journal terminal trong một SQLite transaction.
- T2c orphan + grant invalidation + durable error audit atomically; repeated orphan không tạo audit kép trong coverage hiện tại.
- Recovery classifier không tin `step.status`, xử lý write/delete/entity theo hash và rollback landed steps theo ordinal giảm dần; deterministic unit/persistence tests pass.
- Admin resolve kiểm lease hai lần, giữ gate cho journal còn unresolved khác và có real SQLite/filesystem coverage cho restore/accept-current; finding còn lại là race với external edit sau observation.
- BackupStore create dùng temp + fsync + verify + rename và cleanup orphan grace; tamper/rename/fsync failure tests pass. Vấn đề là orchestration/precondition/retention quanh store, không phải primitive publish happy path.
- Tool audit redaction, retry-once, journal ownership và terminal relation tool→revision→mutation có focused coverage; không thấy committed T2b thiếu audit trong đường hiện tại.

## Ưu tiên remediation đề xuất

1. Thiết kế lại filesystem mutation primitive để capture/swap actual previous bytes và enforce precondition ở publish boundary; dùng cùng primitive cho write, delete, rollback và recovery.
2. Đưa lease + project-gate validation vào T1 transaction; thêm cross-process handover test.
3. Sửa backup-failure terminal handling thành abort-or-inline-reconcile, trả đúng `recovery_required` khi pending.
4. Khóa recovery observation/settlement race và reorder startup recovery trước backup retention.
5. Expire/cleanup abandoned grants và thiết kế payload store/retention cho large rollback blobs.
