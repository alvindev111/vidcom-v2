# Spec MCP Server

> **Status**: In Process — remediation review 2026-08-02; 182/183 task hoàn tất, Phase R→V đang xử lý 43 finding trong `mcp-server-review.md`.

> **Related Documents**:
> - [Detailed Goals](./spec-mcp-server-detailed-goal.md) — **Approved**, reconfirmed 2026-08-02
> - [Detailed Design](./spec-mcp-server-detailed-design.md) — **bản 6, Approved 2026-08-02**
> - [Implementation Checklist](./spec-mcp-server-implementation-checklist.md) — **Approved 2026-08-02**
> - [Canonical build order](../../../product-features/15-build-order.md) — Giai đoạn 2
> - [Steering 05 — MCP tool design](../../../steering/05-mcp-tool-design.md)
> - [Steering 13 — MCP protocol compatibility](../../../steering/13-mcp-protocol-compatibility.md)
> - [Spec trước: Core Backend Foundation](../spec-core-backend-foundation/spec-core-backend-foundation-complete.md)

## Spec Goal

Cung cấp **bộ tool MCP của Phase 2** để Codex/Claude Code đọc và sửa project VidCom qua tool contract có giới hạn (**D1**): một Tool Registry protocol-agnostic phục vụ cả hai protocol era trên cả hai transport vật lý, mọi tool gọi Application Core, mọi tool call được audit, và `vidcom mcp` chạy được như subprocess stdio của một AI host.

> Đây **không** phải "mọi khả năng của backend đều có đường vào cho AI" — render, TTS, snapshot, validate, registry, asset đều chưa có tool ở Phase 2. Mục tiêu là dựng đúng bộ khung và bộ tool đầu tiên.
>
> Phase 2 **bao gồm nâng cấp Core**: write authority phải hỗ trợ mutation nhiều file thì "một thao tác = một revision" mới thành sự thật. Xem [Detailed Goals §2.2](./spec-mcp-server-detailed-goal.md).

## Spec Stories

- **AI điều khiển được VidCom**:
  - Là người dùng dùng Claude Code, tôi muốn agent đọc được cấu trúc project của tôi để nó không phải đoán scene id hay timing.
  - Là người dùng, tôi muốn agent sửa được scene, text và file qua tool để mọi thay đổi vẫn đi qua write authority, có revision và audit.
  - Là người dùng, tôi muốn **một thao tác của agent là một revision** — crash giữa chừng không để lại project nửa vời.
  - Là người dùng, tôi muốn agent **không** xoá được thứ gì nếu **tôi** chưa duyệt — không phải nếu agent tự nói là tôi đã duyệt.
- **Một tool set, hai protocol era**:
  - Là maintainer, tôi muốn định nghĩa tool **một lần** để hai transport vật lý và hai protocol era không đẻ ra nhiều bản định nghĩa.
  - Là người dùng dùng host đời cũ, tôi muốn VidCom vẫn phục vụ được mà không phải nâng cấp host.
  - Là người dùng dùng host `2026-07-28`, tôi muốn nhận đúng `resultType`, `CacheableResult` và MRTR thay vì bản degrade.
- **An toàn và truy vết được**:
  - Là người dùng, tôi muốn biết agent đã làm gì trên project của mình, kể cả khi nó chạy lúc tôi không nhìn.
  - Là kỹ sư vận hành, tôi muốn biết một tool call đến từ protocol revision nào khi debug hành vi lạ.
- **Chạy được như một AI host mong đợi**:
  - Là AI host, tôi muốn spawn `vidcom mcp` và bắt tay thành công mà không bị log lẫn vào `stdout`.
  - Là AI host modern, tôi muốn gọi `server/discover` để biết VidCom hỗ trợ gì trước khi gọi tool.

## Spec Planning

- **Supplementary files**:
  - [Detailed Goals](./spec-mcp-server-detailed-goal.md) — **Approved**, reconfirmed 2026-08-02
  - [Detailed Design](./spec-mcp-server-detailed-design.md) — **bản 6, Approved và implemented**
  - [Implementation Checklist](./spec-mcp-server-implementation-checklist.md) — **In Process, 182/183**
- **Date**: chưa chốt theo lịch. Ước lượng build-order 2–3 tuần ban đầu không còn đáng tin sau khi scope mở rộng thêm composite recovery, grant, backup, credential và admin recovery; lịch thực tế cần velocity của đội.
- **Capacity**: **132 SP** qua 16 phase A→P và 140 task; đây là estimate planning, không phải cam kết lịch. Task count tăng do deep review tách các mega-test thành logic / real datastore / failure injection / regression và bổ sung prepare-plan còn thiếu cho `delete_file`; scope và SP không tăng.
- **Testing**: Contract test **chạy hai lần**, một lần cho mỗi thế hệ protocol; unit test cho Tool Registry và mapping; integration test trên **SQLite + filesystem thật trong thư mục tạm** cho đường ghi và audit; golden file cho `tools/list` của cả hai thế hệ.
  > Datastore thật của spec này vẫn là SQLite trong app-data + filesystem trong temp directory, đúng runtime production. Không mock `node:fs`, không in-memory stand-in.
- **Risks**:
  - **Nâng cấp write authority là rủi ro lớn nhất Phase 2**: `MutationRequest` hiện là union một-file-hoặc-một-entity ([write-authority.ts:20](../../../../packages/core/src/service/write-authority.ts#L20)). Thêm mutation composite chạm vào journal, revision, recovery — tức đúng phần Phase 1 đã ổn định và có 180 test bám vào. Làm hỏng chỗ này là hỏng cả nền móng, không chỉ hỏng MCP.
  - **Phải sửa bảng, không chỉ thêm bảng**: review Design phát hiện `revision` + `revision_blob` không biểu diễn được một composite. Phải mở rộng `ck_revision_kind` và `ck_journal_status` — SQLite không `ALTER` check constraint tại chỗ nên phải table-rebuild. Migration test phải phủ việc này.
  - **Recovery hiện tại là roll-forward, không phải rollback** ([reconcile-pending-mutations.ts:44](../../../../packages/core/src/usecase/reconcile-pending-mutations.ts#L44)). Composite thêm nhánh "hỗn hợp" chưa từng tồn tại. Nhánh này là chỗ dễ sai nhất của cả spec, và nó chỉ chạy lúc khởi động sau crash — tức khó phát hiện nếu test không phủ đủ.
  - **`createScene` hiện ghi ba lần rời** ([project-writes.ts:240](../../../../packages/core/src/usecase/project-writes.ts#L240)) và output không có `revision`/`diagnostics`. Nó phải được viết lại, không chỉ được gọi lại.
  - **Phụ thuộc sâu vào hành vi mặc định của SDK**: sau Q10, phần lớn negotiation, stamp field theo era và MRTR do `server@2` lo. Đó là điểm mạnh, nhưng nghĩa là một lần nâng SDK có thể đổi hành vi mà ta không viết dòng nào. Contract test phải khoá hành vi đó lại (AC 9.8).
  - ~~Tasks extension~~ (S4): đã trả lời — `server@2.0.0` có schema + `RELATED_TASK_META_KEY`, không có task manager. Giữ ngoài phạm vi.
  - ~~MRTR request ID~~ (S5): đã trả lời — tương quan qua `requestState`, không qua request ID; `server@2.0.0` hỗ trợ đầy đủ phía server.
  - **Claude Code chỉ nói legacy** (S6, đã xác minh): binary `2.1.207` có `2024-10-07`…`2025-11-25`, LATEST `2025-11-25`, **0** lần xuất hiện `2026-07-28`. Legacy là đường **duy nhất** hoạt động với Claude Code hôm nay → phải làm trước, không phải làm sau. Codex `0.146.0` chưa xác minh được (launcher JS, binary thật không nằm trên đĩa).
  - ~~Q10~~: **đã đóng bằng spike 2026-08-01** — `server@2.0.0` một mình phục vụ cả hai era trên **cả** HTTP lẫn stdio (4/4 probe pass). `sdk@1.x` xuống devDependency. Rủi ro "hai SDK cùng chạy production" biến mất; rủi ro còn lại là phụ thuộc sâu vào hành vi mặc định của SDK, nên contract test phải khoá hành vi đó lại.
  - **`deleteScene` là use case ghi phức tạp nhất Phase 2**: gỡ mount, xoá file sub-composition **chỉ khi không còn tham chiếu**, thu hẹp root duration, dọn narration JSON + WAV, dọn `preview-settings.scenes[id]`, tạo backup restore được — tất cả trong **một** mutation. Sáu edge case đã được trả lời ở Requirement 6b, nhưng chúng cho thấy độ khó.
  - **Approval grant là cơ chế mới, chưa có tiền lệ trong codebase**: phải phát hành, bind, hết hạn, chống replay, và dùng được cả từ UI lẫn CLI headless. Rủi ro là làm quá phức tạp; xem Q13.
  - **Auth cho AI host qua Streamable HTTP chưa có tiền lệ**: Phase 1 cấp phiên bằng nonce trên URL → cookie, thiết kế cho browser. AI host không phải browser. Vòng đời credential đã định nghĩa ở Requirement 6d nhưng chưa được hiện thực ở đâu.
  - ~~Import boundary~~: đã giải — mount qua injection giống `projectReads`/`jobs`/`events`. Cả hai lệnh cấm import giữ nguyên.
  - ~~Audit cho tool đọc~~: đã giải — thêm row `action = "tool:<tên>"`, tool ghi fail-closed trong cùng transaction, tool đọc fail-open. Cột `protocol_version` đã có sẵn, không cần migration.
- **Commitments**:
  - Thực thi theo dependency order A→P; migration B, composite/recovery E–F và verification P là hard gate.
  - Bám Giai đoạn 2 của build order (2.1 → 2.10), **cộng** `deleteScene` và nâng cấp Core đã duyệt.
  - Mọi persistence phase có logic test + SQLite/filesystem thật; contract matrix chạy 2 era × 2 transport.
  - Không bắt đầu production code cho tới khi Implementation Checklist được duyệt tường minh.

## Quyết định phạm vi (2026-08-01)

| Câu hỏi | Quyết định |
|---|---|
| `deleteScene` — Core chưa có, mà tool destructive cần đối tượng | **Phương án A**: Phase 2 thêm `deleteScene` vào Core; gỡ `SC-1` khỏi build order 3.7 |
| Transport nào | **Cả stdio lẫn Streamable HTTP** |
| Endpoint MCP | **Định địa chỉ theo protocol revision**: `/api/mcp/<revision>` để **pin và debug**; `/api/mcp` là entry point chuẩn, SDK tự phân loại era |
| Mount ở đâu | **Injection qua `ServerAppDependencies`**, giống `projectReads`/`jobs`/`events`. `mcp` không import `server`, `server` không import `mcp` |
| `/api/mcp/latest` | **Có expose**, kèm tài liệu nói rõ đây là moving target |
| Audit protocol revision | **Dùng cột `protocol_version` đã có sẵn** trong `audit_entry` — không thêm cột, **không migration**. *Sửa lại quyết định trước.* |
| Quan hệ audit tool ↔ mutation | **Thêm row**, không thay thế: tool row `action = "tool:<tên>"` là nguyên nhân, mutation row `file.write`/`entity.patch` là kết quả, nối bằng `revision_id` |
| Audit failure semantics | Tool **ghi**: fail-closed (audit nằm trong cùng transaction với mutation). Tool **đọc**: fail-open + log cảnh báo |
| Xác nhận destructive | **Approval grant do daemon phát hành** sau hành động của con người. **Bỏ** `confirm: true` — agent tự đặt được nên nó không chứng minh gì. MRTR là kênh dẫn, không phải bằng chứng |
| Auth cho AI host | **Xử lý trong MCP Bridge**, kèm vòng đời cấp / xoay vòng / thu hồi |
| Thứ tự transport | **Legacy trước, modern sau** — vì Claude Code hiện chỉ nói legacy |
| Kiến trúc | **Một runtime SDK**. Spike Q10 chứng minh `server@2` một mình phục vụ cả hai era trên cả HTTP lẫn stdio. Hai transport **vật lý**, hai protocol **era**, **không** có hai adapter theo era |
| `sdk@1.x` | **devDependency** — chỉ làm client legacy trong contract test |
| Nâng cấp Core | **Trong phạm vi**: mutation composite, `createScene` atomic có revision/diagnostics, `setSceneScript` đánh dấu narration stale |

Chi tiết và hệ quả: [Detailed Goals §Quyết định đã chốt](./spec-mcp-server-detailed-goal.md).

## Phase Approvals

- **Detailed Goals**: **Approved** — người dùng tái xác nhận AC 2.11, 5b.3–4e và 7.4b–4c ngày 2026-08-02
- **Detailed Design**: **bản 6 Approved 2026-08-02** — người dùng xác nhận cùng checklist qua lệnh thực thi `/goal`
- **Implementation Checklist**: **Approved 2026-08-02** — cùng lệnh `/goal` authorize Code Execution A→P, giữ nguyên Execution Contract

## During Spec

- **Standups**: 2026-08-01 — Phase 1 xác minh xanh (typecheck sạch, boundaries pass, 180/180 test). Spike Q10 chạy và đóng. Detailed Goals duyệt sau một vòng review 7 finding.
- **Impediments**: không có tại thời điểm bắt đầu Code Execution
- **Adjustments**: 2026-08-02 — journal persist `grant_id` + pending tool audit; T2 failure giữ pending và project gate; read surface công bố recovery status; approval threat boundary được ghi rõ. Deep review checklist bổ sung DR-20 để truyền durable audit context qua cả mutation one-step, khóa runtime defaults/artifact map/verify commands và tách mega-test thành task 1–4 giờ.

## Spec Review

- **Completed**: 2026-08-02 — local Verification Matrix 10/10 exit 0; ship commit `db7fd685af37e8efcd0e6c09df92aa1865911414` có CI #6 Success 2m54s; closeout candidate `f01d4b496126202d53ddeaf42dcea1606118b10a` có CI #7 Success 2m56s.
- **Reopened**: 2026-08-02 — review độc lập tại `mcp-server-review.md` hợp nhất 43 finding (1 Critical, 10 High, 24 Medium, 8 Low). Claim release-ready bị rút lại cho tới khi Phase R→V hoàn tất và Verification Matrix xanh lại.
- **Demo**: exact SDK legacy `1.30.0` và modern client `2.0.0` resolve tên lệnh `vidcom` từ CLI Phase 2 đã pack trong artifact tạm. Cả hai negotiate/list/call; modern host nhận elicitation, gọi trusted `vidcom approve`, retry `delete_file` thành công, có backup/audit, child đóng sạch và lease về 0. Đây là source-checkout launcher; packaged SEA vẫn là carry-over Phase 4. Rerun riêng: 1 file/1 test, exit 0.
- **Feedback**: contract cần giữ protocol-only stdout và admin approval ngoài MCP capability; cả hai đã thành dedicated CI guards. Closeout audit còn phát hiện Next production host chưa inject MCP Registry/credential verifier; wiring đã được bổ sung và `test:runtime-smoke` nay cấp bearer bằng CLI thật rồi gọi `/api/mcp`.

## Spec Retrospective

- **Well**: dependency order làm lộ và xử lý sớm migration/composite recovery trước transport; real datastore matrix bắt được đúng T2 failure semantics.
- **Not Well**: raw TypeScript CLI không chạy trực tiếp ổn định dưới Node, còn Bun thiếu `node:sqlite`; cần wrapper Node + `tsx` loader thay vì một entry runtime duy nhất.
- **Improvements**: giữ contract/golden/schema-drift gates có tên riêng trong CI; Phase 4 thay in-process stdio ownership bằng authenticated daemon IPC như kiến trúc đích.

## Next Spec Adjustments

- **Changes**: implementation dùng một server SDK, exact clients chỉ ở dev/test; `vidcom mcp` Phase 2 trực tiếp sở hữu lease/runtime thay vì IPC bridge chưa được xây.
- **Carry-over**: tasks extension, OpenTelemetry, daemon IPC bridge, render/TTS/snapshot tools và packaged SEA artifact.
- **Lessons**: destructive safety cần bind plan hash + target hashes + revision và settle grant/audit trong cùng journal transaction; MRTR chỉ là kênh nhập grant, không phải authority.
