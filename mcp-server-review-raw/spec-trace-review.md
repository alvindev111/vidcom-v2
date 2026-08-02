# Raw Review — Spec Traceability and Implementation Honesty

Không có finding Critical. Review read-only; không sửa source/product/spec files.

## High

### 1. Pinned HTTP routes làm mất `credentialId` trước khi ghi audit

Evidence:

- `packages/mcp/src/http.ts:67-69` gọi `inner(request)` khi revision khớp, bỏ `options.authInfo`.
- `packages/mcp/src/server.ts:44-46` chỉ lấy credential từ `requestContext.http?.authInfo?.clientId` hoặc `factoryContext.authInfo?.clientId`.
- `packages/mcp/src/registry/registry.ts:116-126,177-186` dùng giá trị này làm `credentialId` cho pending và terminal audit.
- Vi phạm `llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-detailed-goal.md:272-279`, đặc biệt AC 6d.6: audit phải ghi định danh credential.
- Checklist tuyên bố coverage tại `llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-implementation-checklist.md:598-607`, đặc biệt N.8 tại dòng 602 và Execution Log tại `:1221-1223`.

Repro thực tế đã chạy:

```text
{"key":"","status":200,"credentialId":"credential_probe"}
{"key":"2025-06-18","status":200,"credentialId":null}
{"key":"latest","status":200,"credentialId":null}
```

Command repro dùng `createMcpHttpHandlers(createTransportRegistry(audits))`, gửi một `tools/call` hợp lệ và truyền:

```ts
{ authInfo: { token: "", clientId: "credential_probe", scopes: [] } }
```

Vì sao test không bắt:

- `tests/server/mcp-security.test.ts:124-138` chỉ kiểm Hono truyền credential vào fake handler.
- Real Registry audit tại `tests/server/mcp-security.test.ts:187-218` chỉ gọi `/api/mcp`, không gọi exact/latest.
- `tests/mcp/revision-pin.test.ts:220-239` kiểm canonical result qua entry/exact/latest nhưng không truyền hoặc assert `authInfo`.
- Bốn suite liên quan vẫn xanh: `mcp-security`, `revision-pin`, `contract-matrix`, `ci-guards` — 4 files, 24 tests.

Impact:

- Tool call vẫn được perimeter xác thực, nhưng mọi successful exact revision và `/latest` request mất credential identity trong Registry/audit.
- Audit không thể truy ra credential nào đã gọi tool, trái Requirement 6d.6 và claim closeout N.8.
- Bearer không bị lộ và authorization perimeter vẫn hoạt động; lỗi nằm ở attribution/audit handoff.

Edge cases cần regression:

- `/api/mcp/<legacy-revision>` exact match.
- `/api/mcp/2026-07-28` exact modern match.
- `/api/mcp/latest`.
- Invalid JSON và classifier reject đang giữ `options`; exact successful match mới là nhánh làm rơi context.

Suggested fix:

- Đổi nhánh exact match thành `inner(request, options)`.
- Thêm integration test real Hono → SDK handler → Registry audit cho entry, exact legacy, exact modern và latest.
- Assert audit có credential ID đã verify và serialized audit/log không chứa bearer plaintext.

## Medium

### 2. Phase Verification Matrix đã được đánh dấu hoàn tất nhưng nhiều command không còn chạy được

Evidence:

- `llm-documents/specs-and-process/specs/spec-mcp-server/spec-mcp-server-implementation-checklist.md:182-203` quy định exact focused commands.
- Dòng 184 nói rõ không được mark phase `[x]` nếu focused command chưa có exit code 0 trong Execution Log.
- Phase C tại dòng 190 tham chiếu:
  - `tests/core/mcp-domain-contracts.test.ts`
  - `tests/adapter/mcp-port-adapters.test.ts`
  Hai file này không tồn tại.
- Chạy nguyên văn command Phase C cho kết quả:

```text
$ vitest run tests/core/mcp-domain-contracts.test.ts tests/adapter/mcp-port-adapters.test.ts

No test files found, exiting with code 1
error: script "test" exited with code 1
```

- Execution Log `:778-783` vẫn ghi Phase C hoàn tất bằng một tập khác: “focused 4 files/60 tests”.

Các phase có path stale/nonexistent trong matrix:

- C: cả hai path không tồn tại.
- D: `tests/adapter/mcp-journal-transactions.test.ts` không tồn tại.
- E: `tests/core/composite-write-authority.test.ts` và `tests/adapter/composite-write-persistence.test.ts` không tồn tại.
- G: `tests/core/mcp-project-reads.test.ts` và `tests/adapter/mcp-read-model.test.ts` không tồn tại.
- H: `tests/adapter/approval-grant-persistence.test.ts` không tồn tại.
- J: `tests/core/mcp-project-writes.test.ts` và `tests/adapter/destructive-usecases.test.ts` không tồn tại.

Các tên thực tế gần tương ứng gồm:

- `tests/adapter/composite-journal.test.ts`
- `tests/adapter/composite-write-authority.test.ts`
- `tests/adapter/approval-grants.test.ts`
- `tests/adapter/project-destructive-usecases.test.ts`
- `tests/core/project-usecases.test.ts`

Impact:

- Checklist không còn tái hiện được bằng chứng phase gate.
- Claim “không mark phase nếu command chưa exit 0” không đúng với exact document hiện tại, dù full suite hiện xanh.
- Reviewer hoặc CI runner làm theo tài liệu sẽ gặp failure giả trước khi tới code validation.

Suggested fix:

- Cập nhật Phase Verification Matrix sang tên test thực tế.
- Ghi rõ command thay thế trong Execution Log nếu artifact đã được đổi tên/chia lại.
- Chạy lại từng focused gate C/D/E/G/H/J và lưu exact command + exit code.
- Thêm guard kiểm mọi test path được nhắc trong matrix tồn tại.

### 3. Approval trace tự mâu thuẫn về việc Detailed Design v6 đã được duyệt hay chưa

Evidence:

- Checklist `spec-mcp-server-implementation-checklist.md:21-24` nói v6 đã approved và Code Execution được authorize.
- Main spec `spec-mcp-server-complete.md:94-96` nói Goals, Design v6 và Checklist đều approved.
- Nhưng `spec-mcp-server-detailed-goal.md:423` nói Design v6 “hiện chờ tái xác nhận”.
- `spec-mcp-server-detailed-design.md:1470-1474` vừa ghi `Approved and implemented` vừa nói “Bản 6 cần tái xác nhận”.
- Checklist `spec-mcp-server-implementation-checklist.md:751` vẫn đánh dấu `[x]` cho câu “Approval Gate giữ Pending Confirmation; production code vẫn bị chặn”.
- `implementation-notes.html:22` lại nói lệnh `/goal` là xác nhận Design v6, checklist và Code Execution.

Impact:

- Audit trail không xác định rõ approval thật áp dụng cho v5 hay v6.
- Một reviewer độc lập không thể biết DR-20 đã được user phê duyệt trước code hay được hợp thức hóa sau đó.
- Đây là process inconsistency trong spec đã đóng, không trực tiếp chứng minh product behavior sai.

Suggested fix:

- Chọn một canonical approval fact và revision.
- Nếu `/goal` đã duyệt v6, sửa mọi câu “cần/chờ tái xác nhận” và item Pending Confirmation.
- Nếu `/goal` chỉ duyệt v5, mở lại gate cho DR-20/v6 thay vì giữ trạng thái Complete.
- Ghi confirmation event một lần trong main spec rồi để Goals/Design/Checklist link về đó.

## Low

### 4. `implementation-notes.html` không giữ thứ tự phase, làm hard-gate history trông như bị vi phạm

Evidence:

- `implementation-notes.html:38` ghi Phase C hoàn tất.
- `implementation-notes.html:51` ghi Phase D hoàn tất.
- `implementation-notes.html:64` ghi Phase E hoàn tất.
- Sau đó `implementation-notes.html:77` mới ghi Phase B hoàn tất.
- Checklist Dependency Order và Execution Log lại ghi đúng B→C→D→E tại `spec-mcp-server-implementation-checklist.md:61-69,764-795`.

Impact:

- Reviewer chỉ đọc implementation notes có thể kết luận nhầm D/E đã chạy trước migration gate B.
- Tài liệu vẫn chứa đủ nội dung; lỗi là thứ tự trình bày và độ tin cậy của evidence timeline.

Suggested fix:

- Sắp section theo phase/execution order, hoặc thêm timestamp/sequence number rõ ràng.
- Giữ một bảng index Phase → section → verification command để tránh nhầm timeline khi append song song.

## Areas checked with no issue

- Đếm đúng 140 top-level task A–P:
  - A 7, B 9, C 7, D 9, E 11, F 9, G 5, H 7, I 8, J 12, K 8, L 11, M 11, N 9, O 9, P 8.
- Tất cả task ID A.1→P.8 là duy nhất và đủ theo số phase công bố.
- Không có task implementation chưa check; Q12 Codex được để mở có chủ đích và nằm trong deferred D6.
- Không có `test.skip`, `it.skip`, `describe.skip`, `TODO` hoặc `FIXME` trong các surface MCP/Core/server/CLI được rà.
- Contract matrix tại `tests/mcp/contract-matrix.test.ts:19-29,39-104` thực sự list và gọi đủ 10 tool qua 2 era × 2 transport. Chín tool chủ yếu được gọi theo negative/schema path; positive domain behavior được phủ ở các suite khác.
- Tool list được sort deterministic tại `packages/mcp/src/registry/registry.ts:63-75` và golden tồn tại cho cả legacy/modern.
- Working tree sạch tại thời điểm review trước khi tạo raw report này.
- Các suite sau đã chạy xanh: `tests/server/mcp-security.test.ts`, `tests/mcp/revision-pin.test.ts`, `tests/mcp/contract-matrix.test.ts`, `tests/mcp/ci-guards.test.ts` — 4 files, 24 tests.
- Không thấy inconsistency trong con số 140/140; con số này chỉ đếm top-level phase tasks, không đếm 5 nghĩa vụ X.0–X.4 hoặc acceptance sub-checkboxes.
- Main spec, Detailed Goals, Detailed Design, Checklist và implementation notes đều tồn tại; implementation notes đúng tiếng Việt và dùng Tailwind CDN như process yêu cầu.
- Git commit closeout được tìm thấy trong local history; không thể xác minh GitHub Actions cho HEAD qua `gh run list` vì API trả HTTP 404, nên không dùng kết quả đó để phủ nhận CI evidence đã ghi cho các SHA trước.

## Commands/evidence executed

```text
codegraph explore "Spec MCP Server implementation: trace Tool Registry, MCP HTTP and stdio adapters, approval grants, destructive delete_scene/delete_file, composite WriteAuthority recovery, audit linkage, credential auth, and tests."
```

```text
codegraph explore "Trace authenticated HTTP request through packages/server/src/routes/mcp.ts into packages/mcp/src/http.ts pinnedHandler and packages/mcp/src/server.ts ToolRequestContext credentialId."
```

```text
rtk bun run test -- tests/server/mcp-security.test.ts tests/mcp/revision-pin.test.ts tests/mcp/contract-matrix.test.ts tests/mcp/ci-guards.test.ts
Test Files 4 passed (4)
Tests 24 passed (24)
```

```text
rtk bun run test -- tests/core/mcp-domain-contracts.test.ts tests/adapter/mcp-port-adapters.test.ts
No test files found, exiting with code 1
```

Pinned credential comparison:

```text
{"key":"","status":200,"credentialId":"credential_probe"}
{"key":"2025-06-18","status":200,"credentialId":null}
{"key":"latest","status":200,"credentialId":null}
```

No source/product/spec file was edited as part of this review. This raw report is the only file created on parent request.
