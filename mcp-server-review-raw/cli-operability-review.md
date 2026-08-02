# Raw review — CLI, composition root, startup và operability

## Phạm vi

Review read-only implementation tương ứng Phase O của `spec-mcp-server-implementation-checklist.md`, tập trung vào:

- composition root và startup DAG;
- workspace resolution, lease, SQLite lifecycle;
- `vidcom mcp`, signal/stdio cleanup;
- `approve`, `credential`, `backup`, `recovery`;
- stdout/stderr/JSON/exit code;
- executable entrypoint và AI-host smoke;
- claim liên quan trong product docs.

Focused suite hiện tại vẫn xanh:

```text
rtk bun run test -- tests/cli/mcp-commands.test.ts tests/cli/startup.test.ts tests/e2e/mcp-stdio-host.test.ts
Test Files 3 passed; Tests 36 passed
```

Các finding bên dưới là edge mà suite hiện tại chưa khóa.

## Findings theo severity

### P1 — Recovery có thể ghi workspace B trong khi chỉ giữ lease của workspace A

**Evidence**

- `packages/cli/src/startup.ts:99-102` chỉ acquire lease cho `config.workspaceRoot`.
- Ngay sau đó, `packages/cli/src/startup.ts:134-138` gọi `reconcileCompositeMutations(...)` không truyền workspace scope.
- `packages/core/src/usecase/reconcile-composite-mutation.ts:170-183` duyệt toàn bộ pending journal trong app-data, không lọc theo workspace đang lease.
- `packages/cli/src/composition-root.ts:135-145` resolve project bằng workspace hiện tại trước, nhưng nếu không thấy thì fallback sang `project_registry.workspace_root` bất kỳ và dựng `ProjectRef` ngoài workspace đang lease.
- `packages/core/src/usecase/reconcile-composite-mutation.ts:154-155` có thể rollback các step đã quan sát, tức ghi filesystem qua `WorkspacePort`, nhưng flow này không assert lease cho root fallback.
- Targeted CLI lặp lại cùng lỗi boundary: `packages/cli/src/commands/recovery.ts:98-118` chọn và lease workspace active/ENV, sau đó `:148-161` reconcile/resolve journal bằng global `resolveProjectRef` mà không chứng minh journal thuộc workspace đã lease.

**Edge/repro logic**

1. Cùng app-data có registry cho workspace A và B.
2. B có pending composite journal sau crash.
3. Daemon B đang giữ lease B và tiếp tục hoạt động.
4. Chạy `vidcom mcp --workspace A`, hoặc để active workspace là A rồi chạy `vidcom recovery reconcile <journal-của-B>`.
5. Process mới chỉ lease A, nhưng resolver fallback tới path B. Nếu decision là rollback, process mới ghi B song song với daemon B.

Đây là vi phạm trực tiếp single-writer và có nguy cơ corrupt/mất update. Claim ở `llm-documents/product-features/14-local-first-mcp-packaging-architecture.md:277` rằng lease ngăn hai VidCom writer sở hữu cùng workspace vì vậy không đúng ở recovery path.

**Fix đề xuất**

- Mọi startup reconciliation phải query/filter pending journal theo đúng `workspace_root` đang lease.
- `resolveProjectRef` dùng trong runtime scoped MUST NOT fallback ra ngoài injected workspace root.
- Với targeted recovery, đọc journal + project registration trước, resolve đúng workspace của journal, rồi acquire lease đúng root đó trước mọi hash inspection/write.
- Nếu cần global recovery, acquire/release lease riêng cho từng workspace và re-check lease ngay trước filesystem write.
- Thêm test hai workspace + hai lease, trong đó recovery A tuyệt đối không inspect/write B; thêm test targeted journal B khi active workspace A.

### P1 — Một cleanup hook lỗi làm bỏ qua watcher, lease và DB cleanup

**Evidence**

`packages/cli/src/startup.ts:164-169` cleanup tuần tự bằng các `await` không có `finally` độc lập:

```ts
await closeListener(listenerHandle);
await stopBackground();
if (leaseId) await infrastructure.lease.release(leaseId);
await infrastructure.database.destroy();
```

`stopBackground()` tại `packages/cli/src/startup.ts:92-95` cũng short-circuit: scheduler stop lỗi thì watcher không được close.

Repro đã chạy trong review với listener giả ném lỗi khi close:

```text
{"stopError":"listener close failed","leases":{"count":1}}
```

DB vẫn mở và row lease vẫn tồn tại sau `runtime.stop()`.

**Impact**

- SIGINT/SIGTERM có thể trả exit 1 nhưng process vẫn còn watcher/DB handle.
- Lease có thể bị giữ đến TTL; host restart ngay nhận lease denial.
- Cleanup failure ban đầu che mất các resource leak sau nó.

**Fix đề xuất**

- Dùng unwind stack hoặc từng `try/finally` độc lập; luôn thử đủ listener → scheduler → watcher → lease → DB.
- Thu thập lỗi và ném `AggregateError` sau khi mọi cleanup đã chạy.
- Làm `stop()` idempotent và concurrency-safe.
- Test injection lỗi riêng ở listener, scheduler, watcher, lease release và DB destroy; mỗi case vẫn phải chứng minh các bước còn lại đã được gọi và lease được dọn nếu store còn dùng được.

### P1 — `vidcom` entrypoint hiện không chạy trực tiếp; smoke bypass đúng executable contract

**Evidence**

- `packages/cli/package.json:4-9` khai package `private`, bin trỏ `./bin/vidcom.mjs`, export vẫn là source TypeScript.
- `packages/cli/bin/vidcom.mjs:1-6` là source wrapper phụ thuộc `tsx` rồi import `../src/main.ts`.
- File được Git lưu mode `100644`, không executable; `./packages/cli/bin/vidcom.mjs credential list` trả `permission denied`.
- Root checkout không có `node_modules/.bin/vidcom`.
- `tests/e2e/mcp-stdio-host.test.ts:19-20` không spawn lệnh `vidcom`; test spawn `process.execPath` và truyền absolute source-wrapper làm argument. Vì vậy test xanh dù executable thật không tồn tại/không có quyền execute.

**Impact**

O.9/AC nói AI host spawn `vidcom mcp`, nhưng current artifact chỉ chạy khi host được cấu hình thành `node <checkout>/packages/cli/bin/vidcom.mjs mcp ...`. Cách đó phụ thuộc checkout, source `.ts`, workspace symlink và `tsx`, không phải command UX đã claim.

Lưu ý: Node SEA/IPC bridge đúng là Phase 4 theo `llm-documents/product-features/14-local-first-mcp-packaging-architecture.md:277`; finding này không yêu cầu kéo Phase 4 vào Phase 2. Lỗi hiện tại là ngay cả source-wrapper Phase 2 cũng chưa là executable `vidcom` được smoke đúng cách.

**Fix đề xuất**

- Track executable bit `100755` cho bin.
- Tạo/install/link command `vidcom` trong artifact test, không dựa vào `node <source-file>`.
- Smoke trong clean temp/package install và spawn đúng resolved `vidcom` command.
- Nếu Phase 2 chỉ hỗ trợ source checkout, docs/AC phải ghi đúng command thực tế và không gọi nó là production executable.

### P2 — Đóng stdin/host crash không dừng MCP; process tiếp tục renew lease vô hạn

**Evidence**

- `packages/cli/src/commands/mcp.ts:109-131` chỉ chờ `SIGINT`/`SIGTERM`; không race với EOF/close/error của stdio transport.
- `packages/mcp/src/stdio.ts:17-28` chỉ trả handle có `close()`, không expose `closed` promise/callback cho CLI lifecycle.
- Runtime repro: spawn MCP, gọi `child.stdin.end()`, chờ 1.5 giây; process vẫn sống (`exitCode:null`) và chỉ thoát sau khi review gửi SIGTERM:

```text
{"pid":63552,"exitCode":null,"signalCode":null}
{"exit":{"code":0,"signal":null}}
```

**Impact**

Nếu AI host crash hoặc chỉ đóng pipe mà không gửi signal/kill child, VidCom trở thành orphan daemon, scheduler/watcher tiếp tục chạy và lease tiếp tục được renew. Host khởi động lại sẽ bị từ chối lease cho tới khi orphan bị tìm và kill thủ công.

**Fix đề xuất**

- Wrapper stdio phải expose lifecycle completion và xử lý stdin `end`/`close`, stdout `EPIPE`/close như shutdown trigger.
- `runMcpCommand` race signal và transport close, nhưng đi qua cùng idempotent `runtime.stop()`.
- Thêm real-child test: connect, đóng stdin hoặc làm parent process chết mà không SIGTERM, assert child tự thoát và lease row biến mất.

### P2 — Signal handling có hai cửa sổ làm cleanup bị bỏ qua

**Evidence**

- `packages/cli/src/commands/mcp.ts:129-131` hoàn tất toàn bộ `startVidcomMcp()` trước rồi mới cài signal listeners trong `waitForMcpShutdown()`.
- `packages/cli/src/commands/mcp.ts:116-121` gỡ cả hai listener ngay khi nhận signal đầu, trước khi `runtime.stop()` hoàn tất.
- Unit test hiện dùng `EventEmitter`, nên signal thứ hai không có default OS behavior và không phát hiện process bị terminate giữa cleanup.

**Edges**

1. SIGTERM đến sau acquire lease nhưng trước `startVidcomMcp()` return: default signal handler giết process, không gọi foundation cleanup; lease row chỉ hết theo TTL.
2. SIGTERM thứ hai đến khi scheduler đang drain: listeners đã bị remove, Node dùng default behavior và chết ngay, bỏ dở watcher/lease/DB cleanup.

**Fix đề xuất**

- Cài signal gate trước khi bắt đầu startup; startup nên nhận abort signal và unwind phần đã dựng.
- Giữ listeners/no-op repeated signals đến khi cleanup settled; chỉ remove trong `finally` sau stop.
- Nếu muốn second-signal hard exit, phải có grace-period policy tường minh và cố gắng release lease trước.
- Thêm real-process tests gửi signal ở từng startup phase và signal thứ hai trong delayed cleanup.

### P2 — Explicit workspace sai bị bỏ qua và command âm thầm dùng active/cwd khác

**Evidence**

- `packages/cli/src/workspace-selection.ts:41-46` biến explicit invalid thành `{ valid:false }`, rồi resolver tiếp tục active/cwd.
- `tests/core/workspace-and-path-policy.test.ts:18-23` cố ý khóa hành vi explicit invalid → active.
- Repro thực tế: sau khi lưu active workspace `good`, gọi resolver với explicit `/.../typo` trả `good`:

```text
{"explicit":"/.../typo","chosen":"/.../good"}
```

**Impact**

Typo trong `--workspace` hoặc `VIDCOM_WORKSPACE` không fail fast. `vidcom mcp --workspace <sai>` có thể mở và cho agent sửa project ở workspace cũ. Với admin restore/recovery, hậu quả còn khó phát hiện hơn vì người dùng đã thể hiện target tường minh nhưng lệnh dùng target khác.

**Fix đề xuất**

- Chỉ fallback active/cwd khi explicit không được cung cấp.
- Nếu explicit có nhưng không tồn tại/không có marker, trả input exit 2 với path đã redact/thu gọn phù hợp.
- Sửa test hiện tại và thêm integration test có active hợp lệ + explicit typo, assert không startup/không acquire lease/không update active setting.

### P2 — Invalid backup ID vẫn khởi động full writer runtime và có side effect trước khi báo lỗi

**Evidence**

- `packages/cli/src/commands/backup.ts:91-124` chọn workspace, acquire lease, chạy migration/reconciliation/retention cleanup/identity backfill/job recovery/scheduler/watcher.
- Chỉ tại `packages/cli/src/commands/backup.ts:125-127` command mới đọc manifest và phát hiện `backup_not_found`.

**Impact**

`vidcom backup restore typo` tưởng là domain rejection đơn giản nhưng có thể:

- reconcile journal khác;
- prune backup payload cũ;
- bootstrap/ghi `vidcom.json` cho project thiếu identity;
- start/stop scheduler và watcher;
- cạnh tranh lease với app/MCP đang chạy.

Điều này làm invalid admin input có mutation ngoài target và khiến chẩn đoán khó hơn.

**Fix đề xuất**

- Mở app-data DB read seam trước, validate manifest tồn tại/không pruned và derive project/workspace target trước khi dựng writer runtime.
- Sau đó acquire đúng workspace lease và dùng một targeted restore runtime tối thiểu; không cần scheduler/watcher cho one-shot restore nếu Core contract không cần chúng.
- Test unknown backup ID không gọi workspace selection, reconciliation, backfill, scheduler, watcher hoặc lease.

### P2 — Error contract không redact lỗi hạ tầng và Node warning làm lỗi không còn “một dòng”

**Evidence**

- Execution Contract yêu cầu admin error là một dòng đã redact trên stderr.
- `packages/cli/src/main.ts:186-191` in thẳng `error.message` cho mọi unexpected/infra error.
- Repro với `VIDCOM_APP_DATA` trỏ xuyên qua một file:

```text
(node:69236) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
ENOTDIR: not a directory, mkdir '/tmp/vidcom-cli-error-review.L28snz/not-a-dir/child'
exit=1 stdout_bytes=0
```

Absolute app-data path bị lộ và stderr có ba dòng thay vì một.

- `tests/e2e/mcp-stdio-host.test.ts:34-39` chủ động lọc `ExperimentalWarning`, nên smoke che noise thật thay vì khóa launcher sạch.

**Fix đề xuất**

- Map unexpected error ra stable redacted message/code, ví dụ `internal_error`; full detail chỉ vào structured log đã redact.
- Launcher production cần suppress đúng warning `node:sqlite` ở Node version đã pin, hoặc chuyển khỏi experimental surface khi khả dụng; không filter warning trong assertion.
- Add subprocess tests success/failure cho từng admin family: exact one JSON line stdout khi success, exact one redacted stderr line khi fail, exit 0/2/1, không absolute path/SQL/token.

### P3 — `--overlap-ms` nhận giá trị safe integer nhưng ngoài miền `Date`

**Evidence**

- `packages/cli/src/commands/credential.ts:46-51` chỉ kiểm positive safe integer.
- `packages/core/src/service/mcp-credential-service.ts:75-91` cộng trực tiếp vào epoch rồi gọi `toISOString()`.
- Giá trị như `9007199254740991` qua parser nhưng tạo invalid Date/RangeError, bị map thành unexpected exit 1 và raw error thay vì input/domain exit 2.

**Fix đề xuất**

- Bound overlap sao cho `createdAt.getTime() + overlapMs` nằm trong ECMAScript Date range và trong product maximum hợp lý.
- Validate ở CLI boundary và Core config constructor; test maximum/beyond-maximum.

## Các vùng đã kiểm và chưa thấy finding trong phạm vi

- Top-level/app/MCP argument parser từ chối unknown, duplicate, missing value và protocol pin lạ trước startup.
- Protocol pin đọc chung `SUPPORTED_REVISIONS`; không thấy hard-code allowlist thứ hai ở CLI.
- Success output của `approve`, `credential`, `backup`, `recovery` đi qua `writeJson()` và là một compact JSON object + newline.
- Credential plaintext chỉ xuất ở `issue`/`rotate`; `list` omit cả `secret` và `secretHash`; revoke/invalid dùng message đồng nhất `credential_invalid`.
- SQLite main/WAL/SHM đã được runtime probe khi daemon mở; cả ba có mode `0600` trên macOS trong review.
- `backup restore` gọi Core `restoreBackup` qua `WriteAuthority`, không có direct filesystem write trong command handler.
- Recovery parser bắt buộc đúng một choice `--restore-previous` hoặc `--accept-current`; `inspect` không ghi workspace, dù nó vẫn chạy DB migration.
- Happy-path shutdown đóng transport trước background handles, release lease và destroy DB; focused test hiện tại chứng minh đường không lỗi.
- Real smoke hiện gọi legacy rồi modern client, list/call tool, approval round-trip và release lease. Finding ở trên là artifact/EOF/signal edges, không phủ định protocol happy path.
- Product doc đã nói rõ SEA và authenticated IPC bridge thuộc Phase 4; không ghi finding “chưa có SEA” cho Phase 2.

## Commands/repro đã chạy

```text
rtk codegraph explore "MCP Server implementation checklist Phase O composition root startup CLI commands approve credential backup recovery workspace resolution lease database lifecycle signal cleanup packaged entrypoint"
rtk codegraph explore "packages/cli/src/main.ts dispatch runCli main runMcpCommand selectWorkspace startVidcomFoundation DaemonRuntime.stop signals SIGINT SIGTERM"
rtk codegraph explore "startMcpStdio StdioMcpServerHandle close onclose EOF transport packages/mcp/src/stdio.ts"
rtk codegraph explore "reconcileCompositeMutation resolveProjectRef workspace lease writeAtomic journal step orphan current project ref"
rtk bun run test -- tests/cli/mcp-commands.test.ts tests/cli/startup.test.ts tests/e2e/mcp-stdio-host.test.ts
rtk git ls-files -s packages/cli/bin/vidcom.mjs
./packages/cli/bin/vidcom.mjs credential list
```

Ngoài ra đã chạy ba probe tạm, không sửa repo: stdin EOF orphan, listener-close cleanup failure, explicit-invalid workspace fallback; output tương ứng đã ghi trong findings.
